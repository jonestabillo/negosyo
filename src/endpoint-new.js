'use strict';

let mongodb = require('mongodb');
global.ObjectID = require('mongodb').ObjectID,
global.logger = require('winston');
global.moment = require('moment');
let client = require('ari-client');
let util = require('util');
global.rq = require('request');
let cdp = require('./business/Cdp');
global.config = require('./config/negosyo.json');

//We need to work with "MongoClient" interface in order to connect to a mongodb server.
let mongoClient = mongodb.MongoClient;
 
//Set loggers utility
if(config.enableDebug){
    logger.add(require('winston-daily-rotate-file'), {
        filename: config.logFile
    });
}else{
    logger.add(require('winston-daily-rotate-file'), {
        filename: config.logFile
    }).remove(logger.transports.console);
}

// Use connect method to connect to the Server
//Set up database connectivity
global.db = null;
let url = 'mongodb://' + config.database.host + ':' + config.database.port + '/' + config.database.schema;

mongoClient.connect(url).then((database)=>{
    logger.info('Connection established to', url);
    db = database;
}).catch((err)=>{
    logger.error(err.message);
    process.exit(1);
});

// replace ari.js with your Asterisk instance
client.connect("http://" + config.ari.host + ":" + config.ari.port, config.ari.username, config.ari.password).then((ari)=>{
    logger.info('Successfully connected to ARI');
}).catch((err)=>{
    logger.error('Unable to connect to ARI service. Error: ' + err.message);
    process.exit(1);
});