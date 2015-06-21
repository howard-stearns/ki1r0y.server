"use strict";
/*jslint node: true, vars: true, plusplus: true */

var querystring = require('querystring');
var db = require('../db');
var pseudo = require('../pseudo-request');

// Prevent embedded html in strings by replacing them with the corresponding html entities.
function htmlEscape(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/********************************/
var allColors = {}; // currently available colors per room
// 'Silver' is not in the list, as: 1) It is not very visible, and 2) It is reserved for Kilroy.
// 'White', 'Yellow', 'Lime' and 'Aqua' are not in the list because they are not very visible.
var colorList = [ 'Gray', 'Black', 'Red', 'Maroon', 'Olive', 'Green', 'Teal', 'Blue', 'Navy', 'Fuchsia', 'Purple', 'Orange' ];
// Cycles randomly through the colors available in the specified room. Reloads (the same set of) colors as needed.
function getRandomColor(room) {
    var colors = allColors[room];
    if (!colors) {
        colors = allColors[room] = [].concat(colorList);
        colors.sort(function () { return Math.random() > 0.5; });
    }
    // It would be nice to use the same color if the user is in history.
    // But what if someone already has that color?
    return colors.shift();
}

/********************************/
function Message(message, userName, userColor, typing) {
    this.time = (new Date()).getTime();
    this.text = message;
    this.author = userName;
    this.color = userColor;
    this.typing = typing;
}
// System messages are from Kilroy.
function systemMessage(message, optionalMessageColor) {
    message = '<i>' + message + '</i>';
    if (optionalMessageColor) {
        message = '<span style="color:' + optionalMessageColor + '">' + message + '</span>';
    }
    return new Message(message, 'Kilroy', 'Silver');
}

var allHistory = {}; // latest 100 messages per room
var allCounters = {};
//  Give message obj an idtag.
function ensureIdtag(room, obj) {
    // Should keep idtag unique among document element id attributes in case we want to make use of that.
    if (!obj.idtag) {
        var counter = (allCounters[room] || 0) + 1;
        allCounters[room] = counter;
        obj.idtag = 'im' + counter;
    }
    return obj;
}
// Adds message obj to history, with proper timestamp and idtag.
// Can be a continuation of an earlier message from the same author in which it's typing===start.
// Note that this server code is the source of any shared message idtags.
function addHistory(room, obj) {
    var history = allHistory[room];
    if (!history) { history = []; allCounters[room] = 0; }
    if (obj.typing !== 'start') {
        // Find the previously started message. Remove it from history and use it's idtag.
        var i, msg;
        for (i = history.length - 1; i >= 0; i--) {
            msg = history[i];
            if (!msg) { console.log('no msg', i, history.length, obj, history); }
            if ((obj.author === msg.author) && (msg.typing === 'start')) {
                obj.idtag = msg.idtag;
                history.splice(i, 1);
                break;
            }
        }
    }
    history.push(obj);
    allHistory[room] = history.slice(-100);
    return ensureIdtag(room, obj);
}

/********************************/
// Set up handlers on a societ.io listener.
exports.setup = function (io) {
    io.sockets.on('connection', function (connection) {
        var userNametag = false;
        var userHeaders;
        var userColor = false;
        var sceneIdtag = '';
        function log(path, params, error) {
            var req = {url: path || connection.handshake.url, headers: userHeaders};
            if (params) { req.url.pathname += '&' + querystring.encode(params); }
            if (error) {
                if (error.stack) { console.log(error.stack); }
                req.statusCode = 500;
                req.pathname += '&' + querystring.encode({error: error.name, desc: error.message});
            }
            pseudo.info(req);
        }
        // Each user connection (from io.connect in browser) has it's own session state and app-specific message handlers.
        log();
        function send() { return connection.in(sceneIdtag); }
        connection.on('join', function (message) {
            sceneIdtag = message.room;
            connection.join(sceneIdtag);
            userNametag = htmlEscape(message.nametag);
            // FIXME: get a unique user idtag (or even authentication) rather than nametag (which typicallyt has spaces).
            // This is what express loggers will expect for identifying users.
            userHeaders = {authorization: "Basic " + new Buffer(message.idtag + ':').toString('base64')};
            userColor = getRandomColor(sceneIdtag);
            log('/join?scene=' + sceneIdtag + '&plugin=' + message.plugin);
            // This user gets an avatar color...
            connection.emit('color', userColor);
            // ... and the recent session messages...
            var history = allHistory[sceneIdtag];
            if (history) { connection.emit('history', history); }
            // Everyone else gets notified, with side effect of setting up history.
            var msg = addHistory(sceneIdtag, systemMessage(userNametag + ' arrived.', userColor));
            send().broadcast.emit('im', msg);
            // ... and the MOTD.
            // FIXME: generalize this to a MOTD. E.g., timestamp from file. Add to existing sessions when file changes.
            // This message is not in the scene history, because everyone get their own dead last.
            var motd = function (msg) { connection.emit('im', ensureIdtag(sceneIdtag, systemMessage(msg))); };
            motd('<b>This is unsupported, experimental software!</b>');
            //motd("This is Alpha version '<b>BABY</b>': Just enough to show single-user basics.");
            //motd("Upcoming Alpha version '<b>COMFY</b>': More than textured blocks, and a bit of style.");
            //motd("Upcoming Alpha version '<b>BUDDY</b>': Multi-user with animated avatars. (Earlier is multi-user only for chat.)");
            if (message.plugin) {
                motd("Trust the hover-tooltips and these messages.");
            } else {
                motd('Without the <a href="http://unity3d.com/webplayer" target="unity">Unity plugin</a>, you will not be able immerse yourself in the scene, with your avatar interacting with all the things here. Nor will you be able to change the scene or download content. However, you can participate in text chat and search, and examine the public Facebook activity concerning this scene.<br>The plugin <a href="http://unity3d.com/webplayer" target="unity">installs</a> in seconds with one one click in most browsers, and does <i>not</i> require a restart.');
            }
        });
        // A message to everyone in the room, including the sender.
        connection.on('message', function (message) {
            log(null, {scene: sceneIdtag, m: message});
            var msg = addHistory(sceneIdtag, new Message(htmlEscape(message), userNametag, userColor));
            io.sockets.in(sceneIdtag).emit('im', msg);
            // Also fire off a search with the results going only to the sender.
            db.search(message, function (err, results) {
                if (err) {
                    log('/search?', {scene: sceneIdtag, m: message}, err);
                    connection.emit('error', err.message);
                } else {
                    log('/search?', {n: results.length});
                    connection.emit('related', results);
                }
            });
        });
        // Typing messages go to everyone except the sender.
        connection.on('typing', function (isTyping) {
            var msg = addHistory(sceneIdtag, new Message(undefined, userNametag, userColor,
                                                         isTyping ? 'start' : 'end'));
            send().broadcast.emit('im', msg);
        });
        // The disconnect message is sent automatically by the socket.io machinery.
        connection.on('disconnect', function () {
            if (userNametag !== false && userColor !== false) {
                // Tell everyone else the user has left...
                var msg = addHistory(sceneIdtag, systemMessage(userNametag + ' left.', userColor));
                // Missing io.sockets.clients is weird, but it can happen when there are startup errors and the user leaves the page.
                var isLast = !io.sockets.clients || io.sockets.clients(sceneIdtag).length === 1;
                log('/exit?' + querystring.encode({scene: sceneIdtag}), null, !io.sockets.clients && {name: 'no clients'});
                if (isLast) { // if that's the last one, clean up.
                    log('/shutdown?' + querystring.encode({scene: sceneIdtag}));
                    delete allHistory[sceneIdtag];
                    delete allColors[sceneIdtag];
                    delete allCounters[sceneIdtag];
                } else {
                    send().broadcast.emit('im', msg);
                    // We don't push back colors because we'd like new users to
                    // not be confused with whomever just left.
                    // We could push back colors as follows...
                    //    allColors[sceneIdtag].push(userColor); 
                    // ... so that folks with a spotty connection don't shift,
                    // but it's kind of nice to know be subtley notified that someone's
                    // having trouble.
                }
            }
        });
    });
};
