"use strict";
/*jslint node: true, nomen: true */

var fs = require('fs');
var path = require('path');

exports.standard = function (req, res, next) {
    var created = new Date(2014, 0, 11),
        base = 'http://' + req.get('Host'); // Host header includes port, if any.
    function doit(err, personIdtags) {
        if (err) { return next(err); }
        res.render(req.params.id, {
            thumbnailUrl: '/browser/images/kilroy-20.png',
            canonicalUrl: base + req.originalUrl,
            authorUrl: '/about.html',
            ogSection: 'site',
            created: created.getTime().toString(),
            expires: new Date(Date.now() + req.app.locals.oneYearMs).getTime().toString(),
            peopleData: personIdtags ? personIdtags.map(function (nameAndExt) { return path.basename(nameAndExt, '.json'); }) : null,
            fbAppId: req.app.locals.fbAppId, // app.locals apparently don't get merged when we supply second arg to view.
            footers: [
                {title: "My Scenes", url: "/site/myScenes.html"},
                {title: "What's Hot", url: "/site/hot.html"},
                {title: "Help", url: "/site/help.html"},
                {title: "About", url: "/site/about.html"},
                {title: "Privacy Policy", url: "/site/privacy.html"},
                {title: "Contact", url: "/site/contact.html"}
            ]
        });
    }
    if (req.params.id === 'hot') {
        fs.readdir(path.join(req.app.get('dbdir'), 'mutable/people'), doit);
    } else {
        doit();
    }
};
