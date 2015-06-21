"use strict";
/*jslint node: true, vars: true, plusplus: true, forin: true */
var next = setImmediate || process.nextTick;

var async = require('async');
var db = require('./db');
var pseudo = require('./pseudo-request');
var querystring = require('querystring');

/* 
   (All the file names in this description and code are Kilroy object idtags.)

   This garbage collector cleans all and only the needed files.

   The actual "file" access is done through the db module, which must supply methods
   initialize, mark, and sweep. The mark and sweep could be implemented (and initially
   was implemented) by copying the needed files from oldspace to newspace during "mark",
   and then deleting oldspace and renaming newspace to old during "sweep".

   The GC maintains a list of unprocessed oldspace file name references.
   Each file is a JSON serialization of an object that may reference other objects. 
   Processing consists of reading an object from oldspace, marking it,
   and adding any child references to the the list.
   
   Args:
   * A function(name) that will take care of any mutable object references (places) that
     the gc finds. For example, it might copy from an old mutables space to a new.
   * A function(name, callback(err)) that will take care of any media references that
     the gc finds. Media are (possibly large) immutable data that do not reference anything themselves.
   * A callback() that the gc can use to add names to the list. When the GC's 
     own list is empty and this callback answers falsy, the GC is completed.
     The callback can answer an empty list, meaning that the sender is still asynchronously
     retrieving more data, and the GC should ask again later.
   * A callback(error, resultInformationObject) to be run when the gc is completed.

   This is a realtime garbage collector in the sense that it can run concurrently with
   evolution of the data. It does this through the following simplifying requirements:
   * All oldspace files given to the gc are immutable. If the gc or the evolving system write 
     something to newspace many times, the order doesn't matter because all versions are the same.
   * There are no cycles among the references. (Many parent objects reference can reference 
     the same child, but the children cannot reference one of their own ancestors.)
   * The evolving system should write new data to both oldspace and newspace (mutables, immutables,
     and media), and read from oldspace until the gc completes. 


   This gc is:
   * efficient in working memory -- it only keeps one object at a time plus its running queue.
   * not disruptive -- it runs only when nothing else is happening, and then only for long enough
     to process just one name (which are always quite short). Even the read and most writes are asynchronous.
   * robust -- it can fail or be shut down in the middle without damage. (oldspace is still valid)
   * simple -- the addRoots callback can answer duplicate names in the same or subsequent calls, and
     the system can keep other (e.g., mutable) objects in the oldspace directory (as long as it
     maintains and cleans them on its own).
   * inefficient -- which is ok because of the above and being realtime, as long as it does 
     eventually complete. To make progress, it is only necessary that names are added more
     slowly than they are processed.
*/
function collectImmutables(copyMutable, copyMedia, addRoots, progress, callback) {
    var unprocessedNames = [];
    var tick = function () {
        if (!unprocessedNames.length) { unprocessedNames = addRoots(); }
        if (!unprocessedNames) {
            progress.totalTime = new Date().getTime() - progress.startTime;
            return callback(null, progress);
        }
        if (!unprocessedNames.length) { return setTimeout(tick, 20); }
        if (unprocessedNames.length > progress.maxQueue) {
            progress.maxQueue = unprocessedNames.length;  // Just nice to know.
        }
        var name = unprocessedNames.pop(); // Much faster than shift. We don't care about order.
        // The goal here is to keep the server responsive by only taking a tiny, well-bounded
        // time slice here, without growing memory state any more than we already have to.
        // Thus, we asynchronously processes one name completely before starting the next.
        db.mark(name, function (err, obj) {
            if (err) { pseudo.info({statusCode: 500, url: '/gcRef?error=' + err.name + '&desc=' + err.message}); }
            if (!obj) { return next(tick); }
            progress.things++;
            copyMedia(obj.materials || [], function (copyErr) {
                if (copyErr) { return callback(copyErr, progress); }
                async.eachSeries(obj.children || [], function (child, cb) {
                    unprocessedNames.push(child.idvtag || child.idtag);
                    // The presence of a version tag indicates that idtag is a mutable wrapper.
                    // We don't dig inside (caller must), but we do apply copier and recurse through immutable idvtag part.
                    if (child.idvtag) {
                        copyMutable(child.idtag, cb);
                    } else {
                        cb();
                    }
                }, function (err) {
                    if (err) { return callback(err, progress); }
                    next(tick);
                });
            });
        });
    };
    next(tick); // Don't even start until there's nothing else to do.
}

// Go through all people, copy their scenes, and collectMutables of all the scene versions.
function collect(callback) {
    var progress = {people: 0, scenes: 0, versions: 0, places: 0, things: 0, media: 0, startTime: new Date().getTime(), maxQueue: 0}; // getTime so easily printed as url querystring
    // collectImmutables will periodically ask for these and act on them (coming back for more if empty).
    var immutables = [];  // It won't stop until this is empty...
    var examined = false;  // ... and  we have finished examining everything.
    var addRoots = function () {  // Callback collectImmutables uses to get the above.
        var these = immutables;
        immutables = [];
        return (these.length || !examined) ? these : null;
    };

    var doError = function (err) {
        if (err) { immutables = []; examined = true; console.log('FIXME', err); callback(err); }
        return err;
    };
    var copyMutable = function (idtag, cb) {
        db.mark(idtag, function (err, newlyMarked) {
            if (newlyMarked) { progress.places++; }
            cb(err);
        }, 'forceProcessingEvenIfUpdated');
    };
    var copyMaterials = function (materials, cb) {
        db.markMaterials(materials, function (err, nNewlyMarked) {
            progress.media += nNewlyMarked;
            cb(err);
        });
    };
    var started = false;  // We don't collectImmutables until our first iteration.
    db.iterateUsers(function (user, userCb) {
        progress.people++;
        async.eachSeries(user.scenes || [], function (sceneIdtag, sceneCb) { // each scene of the user...
            progress.scenes++;
            db.mark(sceneIdtag, function (err, scene) {
                if (!doError(err) && scene) { // scene is null if it was already marked
                    var key;
                    // Add each mentioned version to our immutables list...
                    //
                    // Each scene version specifies a complete immutable tree, including
                    // any necessary versions of child mutables. So if we handle all
                    // toplevel (scene) versions, then we do not have to descend into
                    // all the versions of child mutables. 
                    //
                    // We could trim the versions here to remove expired ones.
                    // (If we do in the future, we should check with chat and
                    // skip any that have active sessions, because it's not nice to remove
                    // something that someone might use the back button to reach.)
                    // It is not necessary to trim child mutables, as the expired version objects
                    // will end up being trimmed when their parents are, and the references
                    // within the list are not long and will be trimmed when the object is next
                    // saved.
                    var versions = scene.versions || {oldStyle: scene.idvtag};
                    for (key in versions) { progress.versions++; immutables.push(versions[key]); }
                    if (!started) {
                        started = true;
                        collectImmutables(copyMutable, copyMaterials, addRoots, progress, callback);
                    }
                }
                sceneCb(err);
            }, 'forceProcessingEvenIfUpdated'); // there won't be duplicates, so we don't have to worry about hitting them more than once.
        }, userCb);
    }, function (err) { if (!doError(err)) { examined = true; } });
}

// Wait a short while after the first activity in db.
// Then GC from db to db2. 
// When that's done, log the results, reverse and cleanup, and repeat.
exports.pingPong = function (base, delay) {
    var requested = false;
    var inProgress = false;
    var ping = function () {
        if (inProgress) { return exports.requestGC(); }
        if (requested) { clearTimeout(requested); }
        requested = null;
        inProgress = true;
        collect(function (error, progress) {
            var done = function (err) {
                progress = progress || {};
                var stats = { // An object recognized by our standard logger.
                    url: '/gc?' + querystring.encode(progress || {}),
                    startTime: progress.startTime,
                    runtime: progress && progress.totalTime
                };
                inProgress = false;
                if (error) {
                    stats.url += '&errno=' + error.errno + '&code=' + error.code + '&error=' + error.message;
                    stats.statusCode = 500;
                    pseudo.info(stats);
                } else {
                    pseudo.info(stats);
                    if (requested) { next(ping); }
                }
            };
            if (error) {
                done(error);
            } else {
                db.sweep(progress, done);
            }
        });
    };
    // At one time, we used fs.watch to ping when there was a change to oldspace.
    // fs.watch is documented as unstable. On OSX, I find that sometimes if I have an error
    // (e.g., in my code) while watching a directory, watch will not notice a file being
    // added to that directory (e.g., touch <dirname>/x), (even after a reboot, I think).
    // This can be fixed by touch <dirname> (directly, no x), which seems to reset things.
    // Additionally, this doesn't watch oldspace AND oldmutable, and doesn't watch split subdirectories.
    exports.requestGC = function () {
        if (requested) { return; }
        requested = setTimeout(ping, delay);
    };
    // If the gc ran successfully before, newspace/markings will be clean.
    // However, if it failed, there could be crud there that will confuse us, so 
    // make sure everything is clean at startup.
    db.initialize(base);
};

//exports.collect('people/', 'db/', 'db2/', console.log);
