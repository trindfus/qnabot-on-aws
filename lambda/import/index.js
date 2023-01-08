var Promise = require('bluebird');
var aws = require("aws-sdk");
aws.config.setPromisesDependency(Promise);
aws.config.region = process.env.AWS_REGION;
const get_embeddings = require('./embeddings');

var s3 = new aws.S3();
var lambda = new aws.Lambda();
var stride = parseInt(process.env.STRIDE);
var _ = require('lodash');
var convertxlsx = require('convert-xlsx');
var delete_existing_content = require('delete_existing_content');

function isJson(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}

function str2bool(settings) {
    var new_settings = _.mapValues(settings, x => {
        if (_.isString(x)) {
            x = x.replace(/^"(.+)"$/,'$1');  // remove wrapping quotes
            if (x.toLowerCase() === "true") {
                return true ;
            }
            if (x.toLowerCase() === "false") {
                return false ;
            }
        }
        return x;
    });
    return new_settings;
}

async function get_parameter(param_name) {
    var ssm = new aws.SSM();
    var params = {
        Name: param_name,
        WithDecryption: true
    };
    var response = await ssm.getParameter(params).promise();
    var settings = response.Parameter.Value
    if (isJson(settings)) {
        settings = JSON.parse(response.Parameter.Value);
        settings = str2bool(settings) ;
    }
    return settings;
}

const get_settings = async function get_settings() {
    var default_settings_param = process.env.DEFAULT_SETTINGS_PARAM;
    var custom_settings_param = process.env.CUSTOM_SETTINGS_PARAM;
    console.log("Getting Default QnABot settings from SSM Parameter Store: ", default_settings_param);
    var default_settings = await get_parameter(default_settings_param);
    console.log("Getting Custom QnABot settings from SSM Parameter Store: ", custom_settings_param);
    var custom_settings = await get_parameter(custom_settings_param);
    var settings = _.merge(default_settings, custom_settings);
    console.log("Merged Settings: ", settings);
    return settings;
}

exports.step = function (event, context, cb) {
    console.log("step")
    console.log("Request", JSON.stringify(event, null, 2))
    var Bucket = event.Records[0].s3.bucket.name
    var Key = decodeURI(event.Records[0].s3.object.key)
    var progress
    console.log(Bucket, Key);
    s3.waitFor('objectExists', {
            Bucket,
            Key
        }).promise()
        .then(() => s3.getObject({
            Bucket,
            Key
        }).promise())
        .then(x => JSON.parse(x.Body.toString()))
        .then(function (config) {
            console.log("Config:", JSON.stringify(config, null, 2));
            if (config.status === "InProgress") {
                // TODO - design a more robust way to identify target ES index for auto import of metrics and feedback
                // Filenames must match across:
                // aws-ai-qna-bot/templates/import/UpgradeAutoImport.js
                // aws-ai-qna-bot/templates/master/UpgradeAutoExport.js
                // and pattern in /aws-ai-qna-bot/lambda/import/index.js
                var esindex = process.env.ES_INDEX;
                if (Key.match(/.*ExportAll_QnABot_.*_metrics\.json/)) {
                    esindex = process.env.ES_METRICSINDEX;
                } else if (Key.match(/.*ExportAll_QnABot_.*_feedback\.json/)) {
                    esindex = process.env.ES_FEEDBACKINDEX;
                }
                console.log("Importing to index: ", esindex);
                return s3.getObject({
                        Bucket: config.bucket,
                        Key: config.key,
                        VersionId: config.version,
                        Range: `bytes=${config.start}-${config.end}`
                    }).promise()
                    .then(async function (result) {
                        const settings = await get_settings();
                        console.log('opening file')
                        var objects = []
                        try {
                            config.buffer += result.Body.toString()
                            if(config.buffer.startsWith('PK')) {
                                console.log('starts with PK, must be an xlsx')
                                let questionArray = convertxlsx.convertxlsx(result.Body)
                                console.log('number of items processed: ', questionArray.length)
                                questionArray.forEach(question => {
                                    let questionStr = JSON.stringify(question)
                                    console.log(questionStr)
                                    objects.push(questionStr)
                                })
                                config.buffer = ""
                            } else {
                                objects = config.buffer.split(/\n/)
                                JSON.parse(objects[objects.length - 1])
                                config.buffer = ""
                            }
                        } catch (e) {
                            config.buffer=objects.pop()
                        }
                        var out = []
                        for (const x of objects) {
                            console.log('inside import an object')
                            try {
                                var obj = JSON.parse(x)
                                var timestamp = _.get(obj, 'datetime', "");
                                var docid;
                                if (timestamp === "") {
                                    // only metrics and feedback items have datetime field.. This must be a qna item.
                                    obj.type = obj.type || 'qna'
                                    if(obj.type != 'slottype') {
                                        obj.q = obj.q.map(x => {
                                            x = x.replace(/\\*"/g, '');
                                            return x
                                        });
                                    }
                                    if (obj.type === 'qna') {
                                        try {
                                            var topic = obj.t;
                                            obj.questions = await Promise.all(obj.q.map(async x => {
                                                let params = {
                                                    question: x,
                                                    topic: topic,
                                                    settings: settings
                                                };
                                                const embeddings = await get_embeddings(params);
                                                if (embeddings) {
                                                    return {
                                                        q: x,
                                                        q_vector: embeddings
                                                    }
                                                } else {
                                                    return {
                                                        q: x
                                                    }                                                       
                                                }
                                            }));
                                            obj.quniqueterms = obj.q.join(" ");
                                        } catch (err) {
                                            console.log("skipping question due to exception", err);
                                        }
                                        delete obj.q
                                    }
                                    docid = obj._id || obj.qid;
                                } else {
                                    docid = obj._id || obj.qid + "_upgrade_restore_" + timestamp;
                                    // Stringify session attributes
                                    var sessionAttrs = _.get(obj, "entireResponse.session", {});
                                    for (var key of Object.keys(sessionAttrs)) {
                                        if (typeof sessionAttrs[key] != 'string') {
                                            sessionAttrs[key] = JSON.stringify(sessionAttrs[key]);
                                        }
                                    }
                                }
                                delete obj._id;
                                out.push(JSON.stringify({
                                    index: {
                                        "_index": esindex,
                                        "_id": docid
                                    }
                                }))
                                config.count += 1
                                out.push(JSON.stringify(obj))
                            } catch (e) {
                                config.failed += 1
                                console.log("Failed to Parse:", e, x)
                            }
                        }
                        console.log(result.ContentRange)
                        var tmp = result.ContentRange.match(/bytes (.*)-(.*)\/(.*)/)
                        progress = (parseInt(tmp[2]) + 1) / parseInt(tmp[3])
                        return out.join('\n') + '\n'
                    })
                    .then ((ES_formatted_content)=>delete_existing_content.delete_existing_content (esindex, config, ES_formatted_content))   //check and delete existing content (if parameter to delete has been passed in the options {file}
                    .then(function (result) {
                        var body = {
                            endpoint: process.env.ES_ENDPOINT,
                            method: "POST",
                            path: "/_bulk",
                            body: result,
                            headers: {'Content-Type': 'application/x-ndjson'}
                        }
                        return lambda.invoke({
                                FunctionName: process.env.ES_PROXY,
                                Payload: JSON.stringify(body)
                            }).promise()
                            .tap(console.log)
                            .then(x => {
                                config.EsErrors.push(JSON.parse(_.get(x, "Payload", "{}")).errors)
                            })
                    })
                    .then(() => {
                        config.start = (config.end + 1)
                        config.end = config.start + config.stride
                        config.progress = progress
                        config.time.rounds += 1

                        if (config.progress >= 1) {
                            config.status = "Complete"
                            config.time.end = (new Date()).toISOString()
                        }

                        console.log("EndConfig:", JSON.stringify(config, null, 2))
                        return s3.putObject({
                                Bucket: Bucket,
                                Key: Key,
                                Body: JSON.stringify(config)
                            }).promise()
                            .then(result => cb(null))
                    })
                    .catch(error => {
                        console.log(error)
                        config.status = "Error"
                        config.message = JSON.stringify(error)
                        return s3.putObject({
                                Bucket: Bucket,
                                Key: Key,
                                Body: JSON.stringify(config)
                            }).promise()
                            .then(() => cb(error))
                    })
            }
        })
        .catch(cb)
}

exports.start = function (event, context, cb) {
    console.log("starting")
    console.log("Request", JSON.stringify(event, null, 2))
    var bucket = event.Records[0].s3.bucket.name
    var key = decodeURI(event.Records[0].s3.object.key)
    console.log(bucket, key)
    var config = {
        stride,
        start: 0,
        end: stride,
        buffer: "",
        count: 0,
        failed: 0,
        progress: 0,
        EsErrors: [],
        time: {
            rounds: 0,
            start: (new Date()).toISOString()
        },
        status: "InProgress",
        bucket,
        key,
        version: event.Records[0].s3.object.versionId,
    }
    console.log("Config: ", JSON.stringify(config));
    var out_key = "status/" + decodeURI(event.Records[0].s3.object.key.split('/').pop())
    console.log(bucket, out_key)
    s3.putObject({
            Bucket: bucket,
            Key: out_key,
            Body: JSON.stringify(config)
        }).promise()
        .then(x => cb(null))
        .catch(x => cb(JSON.stringify({
            type: "[InternalServiceError]",
            data: x
        })))
}