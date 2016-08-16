'use strict';

let mongodb = require('mongodb');
global.ObjectID = require('mongodb').ObjectID,
global.logger = require('winston');
global.moment = require('moment');
let client = require('ari-client');
let util = require('util');
global.rq = require('request');
let Cdp = require('./business/Cdp');
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
    let cdp = new Cdp();

    // Use once to start the application
    ari.on('StasisStart', function (event, incoming) {
        let answerCall = false;
        
        if(config.enableWhitelist){
            if(inWhitelist(incoming.caller.number, config.whitelist)){
                answerCall = true;
            }
        }
        
        if(answerCall){
            incoming.answer(function(err){
                if(err){
                    logger.error('[STASIS-START][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                    incoming.hangup();
                }else{
                    let subscriptions = db.collection('subscriptions');

                    db.collection('services').findOne({"subServiceId":config.subServiceId}, function(err, service){
                        if(err){
                            logger.error('[STASIS-START][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                            incoming.hangup();
                        }else{
                            subscriptions.findOne({
                                "mobileNo": incoming.caller.number.trim(),
                                "serviceId": service._id,
                                "active": true,
                                "status": "active"
                            },function(err, sub){
                                if(err){
                                    logger.error('[STASIS-START][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                    incoming.hangup();
                                }else{
                                    if(sub == null){
                                        let playback = ari.Playback();

                                        //Insert the new subscription.
                                        let subscription = {
                                            "mobileNo": incoming.caller.number,
                                            "serviceId": service._id,
                                            "subscribeDate": moment().format('YYYY-MM-DD HH:mm:ss'),
                                            "status":"active",
                                            "medias":[{"order":1, "location": service.medias[0].location}],
                                            "currentMedia": 1,
                                            "playbackId": playback.id,
                                            "active":true
                                        }

                                        subscriptions.insert(subscription, function(err, result){
                                            if(err){
                                                logger.error('[SUBSCRIBE-INSERT][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                incoming.hangup();
                                            }else{
                                                logger.info('[SUBSCRIBE-INSERT][' + incoming.id + '][' + incoming.caller.number + '] Done Inserting');

                                                incoming.play( 
                                                    {media: 'sound:' + service.medias[0].location}, 
                                                    playback,
                                                    function (err, playback) { 
                                                        if(err){
                                                            logger.error('[INITIAL_PLAYBACK][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                            registerDtmfListeners(err, playback, incoming, subscriptions); 
                                                        }
                                                    } 
                                                ); 
                                            }
                                        });

                                        //TODO Call Subscription API
                                        cdp.subscribe(subscription).then((result)=>{
                                            logger.info('[SUBCRIBE-API][' + incoming.id + '][' + incoming.caller.number + '] Successfully subscribed to CDP.');
                                        }).catch((err)=>{
                                            logger.error('[SUBCRIBE-API][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                        });
                                    }else{
                                        //TODO Call Charge API
                                        charge(sub, incoming);

                                        let hasMedia = true;

                                        //Check what content to play.
                                        for(let count = 0; count < service.medias.length; count++){
                                            let media =  service.medias[count];
                                            hasMedia = containsMedia(media, sub.medias);

                                            if(!hasMedia){
                                                let playback = ari.Playback();

                                                subscriptions.update(
                                                    {"_id":sub._id},
                                                    {
                                                        $push:{"medias": {"order": sub.medias.length + 1, "location": media.location}},
                                                        $set:{
                                                            "currentMedia": sub.medias.length + 1,
                                                            "playbackId": playback.id
                                                        }
                                                    }
                                                );

                                                incoming.play( 
                                                    {media: 'sound:' + media.location}, 
                                                    playback,
                                                    function (err, playback) {
                                                        if(err){
                                                            logger.error('[INITIAL_PLAYBACK][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                            registerDtmfListeners(err, playback, incoming, subscriptions);
                                                        }
                                                    } 
                                                );

                                                break;
                                            }
                                        }

                                        if(hasMedia){
                                            let playback = ari.Playback();

                                            if(sub.currentMedia == sub.medias.length){
                                                subscriptions.update(
                                                    {"_id":sub._id},
                                                    {
                                                        $set:{
                                                            "currentMedia": 1,
                                                            "playbackId": playback.id
                                                        }
                                                    }
                                                );

                                                incoming.play( 
                                                    {media: 'sound:' + sub.medias[0].location}, 
                                                    playback,
                                                    function (err, playback) {
                                                        if(err){
                                                            logger.error('[INITIAL_PLAYBACK][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                            registerDtmfListeners(err, playback, incoming, subscriptions);
                                                        }
                                                    } 
                                                );
                                            }else{
                                                let playback = ari.Playback();

                                                subscriptions.update(
                                                    {"_id":sub._id},
                                                    {
                                                        $set:{
                                                            "currentMedia": sub.currentMedia + 1,
                                                            "playbackId": playback.id
                                                        }
                                                    }
                                                );

                                                incoming.play( 
                                                    {media: 'sound:' + sub.medias[sub.currentMedia].location}, 
                                                    playback,
                                                    function (err, playback) {
                                                        if(err){
                                                            logger.error('[INITIAL_PLAYBACK][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                            registerDtmfListeners(err, playback, incoming, subscriptions);
                                                        }
                                                    } 
                                                );
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    });
                }
            }); 
        }else{
            logger.error('[STASIS-START][' + incoming.id + '][' + incoming.caller.number + '] Mobile Blocked.');
            incoming.hangup();
        }
    });

    function registerDtmfListeners (err, playback, incoming, subscriptions) {
        incoming.on('ChannelDtmfReceived', 
            function(event, channel){
                let digit = event.digit;
            
                db.collection('services').findOne({"subServiceId":config.subServiceId}, function(err, service){
                    if(err){
                        logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                        incoming.hangup();
                    }else{
                        subscriptions.findOne({
                            "mobileNo": incoming.caller.number.trim(),
                            "serviceId": service._id,
                            "active": true,
                            "status": "active"
                        },function(err, sub){
                            if(err){
                                logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                            }else{
                                switch (digit) {
                                    case '1':
                                        let currPlayback = ari.Playback();
                                        let prevPlayback = ari.Playback(sub.playbackId);
                                        
                                        subscriptions.update(
                                            {"_id":sub._id},
                                            {$set:{
                                                "currentMedia": sub.currentMedia - 1,
                                                "playbackId": currPlayback.id
                                            }}
                                        );

                                        prevPlayback.stop(function(err, playback){
                                            if(err){
                                                logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                incoming.hangup();
                                            }else{
                                                charge(sub, incoming);
                                                
                                                let media = getPrevMedia(sub, sub.currentMedia - 1, subscriptions);
                                                
                                                if(media){
                                                    incoming.play({ media: 'sound:' + media }, currPlayback, function (err, playback){
                                                        if(err){
                                                            logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                        }
                                                    });
                                                }else{
                                                    logger.info('[PLAYING-FIRST MEDIA][' + incoming.id + '][' + incoming.caller.number + ']');
                                                }
                                            }
                                        });
                                        
                                        break;
                                    case '5':
                                        let currPlayback = ari.Playback();
                                        let prevPlayback = ari.Playback(sub.playbackId);
                                        
                                        subscriptions.update(
                                            {"_id":sub._id},
                                            {$set:{
                                                "currentMedia": sub.currentMedia - 1,
                                                "playbackId": currPlayback.id
                                            }}
                                        );
                                        
                                        prevPlayback.stop(function(err){
                                            if(err){
                                                logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                incoming.hangup();
                                            }else{
                                                charge(sub, incoming);

                                                let media = getNextMedia(sub, service, subscriptions)

                                                if(media){
                                                    channel.play({ media: 'sound:' + media }, currPlayback, function (err, playback){
                                                        if(err){
                                                            logger.error('[DTMF][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
                                                            incoming.hangup();
                                                        }else{
                                                            logger.info('[PLAYING][' + incoming.id + '][' + incoming.caller.number + '] ' + playback.media_uri);
                                                        }
                                                    });
                                                }else{
                                                    logger.info('[PLAYING-FIRST MEDIA][' + incoming.id + '][' + incoming.caller.number + ']');
                                                }
                                            }
                                        });
                                        
                                        break;
                                    default:
                                        //play(channel, util.format('sound:digits/%s', digit));
                                }
                            }
                        });
                    }
                });
        }); 
    }

    function containsMedia(obj, list) {
        for(let i = 0; i < list.length; i++) {
            if (list[i].location === obj.location) {
                return true;
            }
        }
        
        return false;
    }

    function inWhitelist(number, list) {
        for(let i = 0; i < list.length; i++) {
            if (list[i] === number) {
                return true;
            }
        }
        
        return false;
    }

    function charge(sub, incoming){
        if(sub.medias.length >= config.freeContentCount){
            cdp.charge(sub).then((result)=>{
                logger.info('[CHARGE-API][' + incoming.id + '][' + incoming.caller.number + '] Successfully charged to CDP.');
            }).catch((err)=>{
                logger.error('[CHARGE-API][' + incoming.id + '][' + incoming.caller.number + '] ' + err.message);
            });
        }

        return true;
    }

    function getPrevMedia(sub, currentMedia, subscriptions){
        for(let i = 0; i < sub.medias.length; i++) {
            if (sub.medias[i].order === currentMedia) {
                return sub.medias[i].location;
            }
        }
        
        if(sub.currentMedia == 1){
            subscriptions.update(
                {"_id":sub._id},
                {$set:{"currentMedia": sub.medias.length}}
            );
            
            return sub.medias[sub.medias.length - 1].location;
        }else{
            subscriptions.update(
                {"_id":sub._id},
                {$set:{"currentMedia": sub.currentMedia - 1}}
            );
            
            return sub.medias[sub.currentMedia - 1].location;
        }
    }

    function getNextMedia(sub, service, subscriptions){
        //Check what content to play.
        let hasMedia = false;
        let media = null;
        
        for(let count = 0; count < service.medias.length; count++){
            let media =  service.medias[count];
            
            hasMedia = containsMedia(media, sub.medias);

            if(!hasMedia){
                subscriptions.update(
                    {"_id":sub._id},
                    {
                        $push:{"medias": {"order": sub.medias.length + 1, "location": media.location}},
                        $set:{"currentMedia": sub.medias.length + 1}
                    }
                );

                return media.location;
            }
        }
        
        if(sub.currentMedia == sub.medias.length){
            subscriptions.update(
                {"_id":sub._id},
                {$set:{"currentMedia": 1}}
            );
            
            return sub.medias[0].location;
        }else{
            subscriptions.update(
                {"_id":sub._id},
                {$set:{"currentMedia": sub.currentMedia + 1}}
            );
            
            return sub.medias[sub.currentMedia].location;
        }
    }

    ari.start('negosyo');
    logger.info('Negosyo Serye Service Started...');
}).catch((err)=>{
    logger.error('Unable to connect to ARI service. Error: ' + err.message);
    process.exit(0);
});