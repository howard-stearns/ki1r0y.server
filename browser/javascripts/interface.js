 "use strict";
/*jslint browser: true, devel: true, vars: true, plusplus: true, continue: true, nomen: true */
/* Copyright (c) 2013 Beyond My Wall. All rights reserved until we get a clue. */
var FileReader, FB, getUnity, sayOnce, chatLogin, advice, addHistory, kilroyURL, peopleURL, canonicalLocation, _;
var updateLinksStyles, addTimestamp, addPendingHistory, errorMessage, page, logEvent, dimension, timing, removeChildren, makeReorderable, thumbnailURL;
var unityObject, unityReady, post, finalHandler, _, shorten;

// Answer the plugin, or null. The plugin machinery doesn't seem to make use of this,
// but all the examples have it defined (e.g., as a separate function from sendUnity, below.
function getUnity() {
    if (unityObject !== undefined) {
        return unityObject.getObjectById("unityPlayer");
    }
    return null;
}
// Send message and arg to the target object within the plugin.
function sendUnity(target, message, arg) {
    console.log('=>plugin ' + target + ':', message, shorten(arg));
    if (!unityReady) { throw 'Cannot send to plugin before it is ready'; }
    getUnity().SendMessage(target, message, arg);
}

// Msg from Unity. FIXME change this name.
function notifyUser(msg) {
    console.log('plugin =>:', msg);
    //addLocalMessage('<span style="color:Silver">debug: ' + msg + '</span>');
}

var RELATED, SCENE, THING, USER = {}; // We're still transition from a series of scalars to these objects initialized in scene template.

function setEmail(nametag, url) {
    var elt = document.getElementById('email');
    if (!elt) { return; }
    elt.setAttribute('href', 'mailto:?subject=' + nametag
                                                  + ' in Kilroy&X-Mailer=kilroy&body=' + url.replace('public', 'email'));
}
// Two-part entry. The plugin and FB login are both needed, and can complete in any order.
// Saddle up only when ready.
function enterIfReady(fromPlugin, userIdtag, userNametag) {
    unityReady = fromPlugin || unityReady;
    USER.idtag = USER.idtag || userIdtag;
    USER.nametag = USER.nametag || userNametag;

    chatLogin(USER.idtag, USER.nametag, SCENE.idtag); // reverse the order of these two lines if we don't want chat without plugin
    if (!unityReady || !USER.idtag) { return; }

    // ContactInfo and RestoreScene are methods on the root of the scene graph. At this point,
    // (before loading the scene) that object is named 'Scene'. Afterwords, it will use the same 
    // value as SCENE.idtag.
    sendUnity('Scene', 'ContactInfo', location.host + '/' + USER.idtag + '/' + USER.nametag);
    sendUnity('Avatar', 'RestoreScene', SCENE.timestamp + ':' + SCENE.idtag + ':' + THING.idtag);
    document.getElementById('dropzone').setAttribute('title', "Click an object to go to it.\n\nThen move with tab key, arrow keys or a-s-d-w keys.\n\nEsc key exits.");
    setEmail(document.getElementById('ogTitle').getAttribute('content'), location.href);
}
var selectedObjectPath = ''; // Used for property updates back to the scene
var restorePlayer;
function updateBackgroundImage(url) {
    console.log('updateBackgroundImage', url.length);
    document.getElementsByTagName('plugin')[0].style.backgroundImage = "url('" + url + "')";
    document.getElementById('unityPlayer').style.width = '1px';
}
var UPDATED, UPDATE_START, UPDATE_CALLBACKS = []; // Indicates that all updates are complete. Used in testing.
function startUpdate(cb) {
    UPDATED = 0;
    if (cb) { UPDATE_CALLBACKS.push(cb); }
    UPDATE_START = Date.now();
}
function endUpdate() {
    UPDATED = Date.now();
    var interval = UPDATED - UPDATE_START;
    var cbs = UPDATE_CALLBACKS;
    UPDATE_CALLBACKS = [];
    cbs.forEach(function (cb) { cb(); });
    // cbs.forEach(Function.prototype.call, Function.prototype.call); // Obscure alternative to the above line.
    console.log('Updated in ' + interval);
}
startUpdate();
function tabNav(backward) { // tab navigation either forward or backward
    startUpdate();
    sendUnity('Avatar', 'Tabber', backward ? 'false' : 'true');
}
function pluginReady() {    // Sent by plugin when it starts operating (and is thus ready for messages).
    console.log('pluginReady', SCENE.idtag);
    logEvent('admin', 'plugin');
    timing('admin', 'plugin');
    enterIfReady('fromPlugin');
    if (FB) {
        var thumb = function () { sendUnity(selectedObjectPath, 'updateThumbnail'); };
        FB.Event.subscribe('edge.create', thumb);
        FB.Event.subscribe('edge.remove', thumb);
        FB.Event.subscribe('comment.create', thumb);
    }
    if ((navigator.platform.toLowerCase() === 'win32') || _.contains(navigator.userAgent.toLowerCase(), 'windows') || /firefox/i.test(navigator.userAgent)) {
        // Windows plugins (including Unity) are always "on top", regardless of z-index, and their
        // associated DOM elements never see the drag and drop events. 
        // (Looks like Firefox on Mac has the same problem. Note that webkit copies Gecko's navigator.product, appName, etc. Ugh.)
        // So we do a horrible thing on Windows: at the start of a drag we shrink the plugin to 1px,
        // (so that the DOM element can handle the events) and then restore it at the start of the drop 
        // and end of the drag. Yuck.
        var player = document.getElementById('unityPlayer');
        var noticedDrag = false;
        document.ondragenter = function () {
            if (!noticedDrag) {
                console.log('drag enter => capture scene', SCENE.idtag, 'idvtag');
                noticedDrag = true;
                sendUnity('/' + SCENE.idtag, 'captureSceneToBackground', '1');
            }
        };
        var body = document.getElementsByTagName('body')[0];
        document.ondragend = restorePlayer = function () { player.style.width = '600px'; noticedDrag = false; };
        // We won't get dragend when dragging external stuff, so check dragleave mouse position 
        // against the document element bounds to see when the mouse has left.
        var boundX = window.innerWidth || document.documentElement.clientWidth || body.clientWidth;
        var boundY = window.innerHeight || document.documentElement.clientHeight || body.clientHeight;
        document.ondragleave = function (e) {
            e = e || window.event;
            var x = e.clientX, y = e.clientY; // mouse coords
            if ((0 >= x) || (x >= boundX) || (0 >= y) || (y >= boundY)) {
                restorePlayer();
            }
        };
    } else {
        restorePlayer = _.noop;
    }
    document.onkeydown = function (e) { // make at least tab work without clicking scene
        if (_.contains(['EMBED', 'INPUT'], document.activeElement.nodeName)) { return true; } // allow normal processing
        switch (e.keyCode) {
        case 9: // tab
            tabNav(e.shiftKey);
            return finalHandler(e);
        }
    };
}
// FB parse is hideously expensive, and makes the plugin graphics jerky.
// We work around this by starting a new delay every time we think we want
// it, and only really doing the parse when the last one happens.
// The delay is sized to occur after the plugin-initiating action has completed,
// so that hopefully the plugin is just sitting there.
var pendingParse = null;
function requestParse(elt) {
    if (pendingParse) { window.clearTimeout(pendingParse); }
    pendingParse = window.setTimeout(function () {
        pendingParse = null;
        FB.XFBML.parse(elt);
    }, 1600);
}
function updateBreadcrumb(id, url, nametag) { // answers element
    var link = document.getElementById(id);
    link.setAttribute('href', url);
    link.innerHTML = (nametag[0] === '<') ? nametag : _.prune(nametag, 25);
    return link;
}
function updateUser(data, optionalCallback) { // Update user data. FIXME: send through secure plugin
    post(location.origin + '/fbusr/' + USER.idtag + '.json', data, optionalCallback);
}
function Units(name) {
    var factor = 1;
    switch (name) {
    case 'foot': factor = 3.28084; break;
    case 'inch': factor = 39.3701; break;
    case 'centimeter': factor = 100; break;
    case 'millimeter': factor = 1000; break;
    case null:
    case undefined:
    case 'meter':
        break;
    default:
        console.log('Unrecognized units', name);
    }
    this.name = name || 'meter';
    this.to = function (meters) { return meters * factor; };
    this.from = function (userUnits) { return userUnits / factor; };
    this.fixed = function (meters) { return this.to(meters).toFixed(2); };
}
var units = new Units();
// Sent by plugin when it has discovered the appropriate names, and from saved/selected here.
function sceneReady(sceneNametag, objectNametag, sceneTimestamp, idvtag, sceneUserIdtag) {
    console.log('sceneReady scene:', sceneNametag, 'object:', objectNametag, 'timestamp:', sceneTimestamp, 'idvtag:', idvtag, 'user:', sceneUserIdtag);
    SCENE.nametag = sceneNametag || SCENE.nametag;
    SCENE.timestamp = sceneTimestamp || SCENE.timestamp;
    SCENE.idvtag = idvtag || SCENE.idvtag;
    THING.nametag = objectNametag;
    addPendingHistory();
    updateBreadcrumb('sceneNametag', kilroyURL(SCENE.idtag), SCENE.nametag);
    // retrim breadcrumb (e.g., on entry)
    if (objectNametag && (THING.idtag !== SCENE.idtag)) { updateBreadcrumb('objectNametag', kilroyURL(SCENE.idtag, THING.idtag), ' &gt; ' + objectNametag); }
    var fbName = FB && '<fb:name uid="' + sceneUserIdtag + '" linked="false"/>';
    var usr = updateBreadcrumb('sceneUserNametag', peopleURL(sceneUserIdtag), fbName || sceneUserIdtag);
    if (FB) { FB.XFBML.parse(usr); }
    var data = {scene: SCENE.idtag};
    if (sceneUserIdtag === USER.idtag) { data.isMine = true; }
    updateUser(data, function (error, userData) {
        if (error) { console.log('updateUser', error); }
        var input = document.getElementById('units');
        input.selectedIndex = _.map(input.options, function (e) { return e.value; }).indexOf(userData.units);
        units = new Units(userData.units);
    }); // This might be more often than we need...
}

// HTML5 classList.add/remove are nicer, but shims don't work IE older than 8.
function addClass(className, node) {
    node.className += (node.className ? ' ' : '') + className;
}
function removeClass(className, node) {
    node.className = node.className.replace(className, '').replace(/\s+/g, ' ');
}
function enable(node, isAble) { if (isAble) { removeClass('disable', node); } else { addClass('disable', node); } }
function isEnabled(node) { return !_.contains(node.className, 'disable'); }

// Use this instead of setAttribute('href') for kilroyLinks, to avoid clashes with updateLinksStyles.
function setKilroyHref(link, href) {
    link.setAttribute('href', href);
    var savedTitle = link.getAttribute('ktitle');
    if (savedTitle) { link.setAttribute('title', savedTitle); }
    link.removeAttribute('kref');
    link.removeAttribute('ktitle');
    enable(link, true);
}
// Update all kilroyLinks to be distinguished if we're already at what they point to.
function updateLinksStyles(links) {
    var k, nodes = links || document.getElementsByClassName('kilroyLink'), n = nodes.length,
        sceneURL = kilroyURL(SCENE.idtag), objectURL = kilroyURL(SCENE.idtag, THING.idtag);
    var link, kref, href, ref, isStamped, s, o, objectPath;
    // refs without timestamps are considered pointing to us regardless of timestamp.
    // However, if they do specify a timestamp, the timestamp must match.
    var stampedScene = addTimestamp(sceneURL, SCENE.timestamp), stampedObject = addTimestamp(objectURL, SCENE.timestamp);
    for (k = 0; k < n; k++) {
        link = nodes[k];
        kref = link.getAttribute('kref');
        href = link.getAttribute('href');
        ref = kref || href;

        isStamped = ref && _.contains(ref, 'version');
        s = isStamped ? stampedScene : sceneURL;
        o = isStamped ? stampedObject : objectURL;

        objectPath = link.getAttribute('kilroyObjectPath');
        if ((!objectPath && ((ref === s) || (ref === o)))
                || (objectPath === selectedObjectPath)) {
            if (!kref) {
                link.setAttribute('kref', ref);
                link.setAttribute('ktitle', link.getAttribute('title'));
                link.setAttribute('title', "This is where you are now.");
                link.removeAttribute('href');
                enable(link, false);
            }
        } else if (kref) {
            setKilroyHref(link, kref);
        }
    }
}
function isKilroyLink(node) {
    return node && _.contains(node.className, 'kilroyLink');
}
// Try to go where we're told without loading a new page. Answer true if successful.
// path is kilroy pathname identifing a public object, such as /people/aUserIdtag, /places/aSceneIdtag, or /things/anObjectIdtag
// query is the query part of a Kilroy url, which may specify a version (timestamp) and which must have an fb_ref for /things paths.
// mode is 'GoTo' (adds to history) or 'GoBackTo' (which does not).
function softJump(path, query, mode, objectPath) {
    var peopleData = path.match(/\/people\/(.*)/);
    // for now, just allow the normal link behavior. It would be nice to do this without reloading the page.
    if (peopleData) { return false; }
    if (!path) { enable(document.getElementById('properties'), true); advice('You are already there.'); return true; } // disabled
    var thingData = path.match(/\/things\/(.*)/);
    var objectIdtag = (thingData && thingData[1]) || '';
    var sceneData = path.match(/\/places\/(.*)/);
    var queries = {};
    query.slice(1).split('&').map(function (s) { var pair = s.split('='); queries[pair[0]] = pair[1]; });
    var sceneIdtag = (sceneData && sceneData[1]) || queries.fb_ref.slice('public__'.length);
    var timestamp = queries.version;
    if ((sceneIdtag === SCENE.idtag) && (!timestamp || (timestamp === SCENE.timestamp))) {
        sendUnity('Avatar', mode, objectPath || objectIdtag);
    } else {
        SCENE.idtag = sceneIdtag;
        sendUnity('Avatar', (mode === 'GoTo') ? 'RestoreScene' : 'RestoreSceneBack',
                  (timestamp || '') + ':' + (objectPath || (sceneIdtag  + ':' + objectIdtag)));
    }
    return true;
}
function softLink(e) { // click handler for kilroy links. Keeps session going.
    var event = e || window.event;
    var node = event.target || event.srcElement;
    if (!isKilroyLink(node) && isKilroyLink(node.parentNode)) { node = node.parentNode; } //e.g. our use of fb:name element
    // We could create separate non-standard attributes, but href is pretty general, and it's not silly expensive to parse.
    // There is no need to look at kref (see updateLinkStyles), because those are not active links.
    if (softJump(node.pathname, node.search, 'GoTo', node.getAttribute('kilroyObjectPath'))) {
        event.preventDefault();
        return false;
    }
    return true;
}

// Plugin tells us what was saved, so we can update history and title.
function saved(objectIdtag, objectNametag, sceneTimestamp, action, idvtag, path, sceneIdtag) {
    console.log('saved', objectIdtag, objectNametag, sceneTimestamp, action, idvtag, sceneIdtag, 'eol');
    if (SCENE.idtag !== sceneIdtag) { // might have changed if we have a new author
        SCENE.idtag = sceneIdtag;
        sceneReady((sceneIdtag === objectIdtag) && objectNametag, objectNametag, sceneTimestamp, idvtag, USER.idtag);
        advice("Having made a change to someone else's scene, you are now in your own copy of that scene. To change the name of your copy, use the scene's 'properties' tab.");
    } else if ((sceneIdtag === objectIdtag) && (objectNametag !== SCENE.nametag)) { // is there a better way to ensure this?
        SCENE.nametag = objectNametag;
        updateBreadcrumb('sceneNametag', kilroyURL(SCENE.idtag), SCENE.nametag);
    }
    sayOnce('Saved ' + action + ' of ' + objectNametag + '. You can use the browser back button to "undo".', 'undo');
    logEvent('create', action, objectIdtag);
    SCENE.idvtag = idvtag;
    SCENE.timestamp = sceneTimestamp;
    THING.nametag = objectNametag;
    THING.idtag = objectIdtag;
    if (action !== 'undo') { addHistory(objectIdtag, sceneTimestamp, objectNametag, action, SCENE.idvtag, undefined, path); }
    updateLinksStyles();
}
function updateSocial(url, nametag, labelElt) { // Make the social plugins point to url, which should be canonical (no scene)
    if (FB) {
        var metadataBox = document.getElementById('metadataBox');   // The container object.
        // These FB social plugin elements do not accept an id attribute, so getElementById won't work.
        var likeBox = metadataBox.getElementsByTagName('fb:like')[0] || metadataBox.getElementsByClassName('fb-like')[0]; // handle either style
        var existing = likeBox.getAttribute('href');
        if (url !== existing) { // don't requestParse (which flickers) if there's no change.
            var commentsBox = metadataBox.getElementsByTagName('fb:comments')[0] || metadataBox.getElementsByClassName('fb-comments')[0];
            likeBox.setAttribute('href', url);
            commentsBox.setAttribute('href', url);
            requestParse(metadataBox);
            if (nametag.indexOf('<fb') === 0) { requestParse(labelElt); } // In case it's a reference to, e.g., a fb:name.
        }
    }
}
// set content in element, allowing html, and replacing urls/emails with links
function setContent(element, content) {
    element.innerHTML = content;
    // Now make links out of URLs, unless they are already in html.
    var nodes = element.childNodes, index, child;
    var original, anchored, newNode;
    for (index = 0; index < nodes.length; index++) {
        child = nodes[index];
        if (child.nodeType === 3) { // text nodes
            original = child.data;
            anchored = original.replace(/http[s]?:\/\/\S+/g, '<a href="$&" target="_blank">$&</a>');
            anchored = anchored.replace(/\S+@\S+\.\S+/g, '<a href="mailto:$&">$&</a>');
            if (original !== anchored) {
                newNode = document.createElement('span');
                newNode.innerHTML = anchored;
                child.parentNode.insertBefore(newNode, child);
                child.parentNode.removeChild(child);
            }
        }
    }
}
function updateDetailsDisplay(val, label) {
    var button = document.getElementById('detailsButton');
    setContent(document.getElementById('detailsDisplay'), val);
    setContent(button, label || 'message');
    button.style.display = val ? 'inline' : 'none';
}

// Display information in the social tab, without changing locations.
// The initial social info is set statically, so that:
// 1. People can use that to decide whether they want the plugin. i.e., it can't wait for the plugin to set things.
// 2. It doesn't get changed by the plugin scene selection. i.e., a scene restore shouldn't change a user profile social display.
var setProp; // forward reference
function showMetadata(nametag, url, description, urlWithScene) {
    console.log('showMetadata', nametag, url, description, urlWithScene);
    if (!urlWithScene) { urlWithScene = url; }
    var lbl = document.getElementById('publicLabel'), dsc = document.getElementById('publicDesc');
    lbl.innerHTML = nametag;
    setKilroyHref(lbl, urlWithScene);
    setEmail(nametag, urlWithScene);
    dsc.innerHTML = description || '';
    if (lbl.style.display === 'none') { // the tab was being used as a fake input
        var tLbl = document.getElementById('tmpLabel'), tDsc = document.getElementById('tmpDesc');
        var overlay = document.getElementById('spinnerOverlay');
        var lblVal = tLbl.value.trim() || tLbl.placeholder; // not empty
        var dscVal = tDsc.value || tDsc.placeholder;
        if (overlay.style.display !== 'none') {
            overlay.style.display = 'none';
            // We now have a selectedObjectPath, so transfer any new values that were waiting for this...
            if (lblVal !== nametag) { lbl.innerHTML = lblVal; setProp('settag0', null, tLbl, lblVal); }
            if (dscVal !== description) { dsc.innerHTML = dscVal; setProp('setDesc', null, tDsc, dscVal); }
            // ... and set up change handers for any further changes.
            tLbl.onchange = function () { setProp('settag0', null, tLbl); };
            tDsc.onchange = function () { setProp('setDesc', null, tDsc); };
        } else { // we're all done
            lbl.style.display = 'inline'; dsc.style.display = 'block';
            tLbl.style.display = tDsc.style.display = 'none';
            tLbl.onchange = null;
            tDsc.onchange = null;
        }
    }
    updateDetailsDisplay(document.getElementById('details').value, document.getElementById('detailsLabel').value);
    updateSocial(url, nametag, lbl);
    return lbl;
}
// Plugin tells us what has been selected, so we can update history, title, buttons, etc.
function select(objectIdtag, objectNametag, idvtagForHistory, ignoredAuthorIdtag, objectDescription) {
    console.log('select', objectIdtag, objectNametag, idvtagForHistory);
    if (!objectIdtag) { objectIdtag = SCENE.idtag; }
    if (!objectNametag) { objectNametag = SCENE.nametag; }
    var url;
    if (objectIdtag === SCENE.idtag) {
        THING.idtag = '';
        THING.nametag = '';
        url = kilroyURL(SCENE.idtag);
        showMetadata(SCENE.nametag, url, objectDescription);
        updateBreadcrumb('objectNametag', undefined, '');
    } else {
        THING.idtag = objectIdtag;
        THING.nametag = objectNametag;
        url = kilroyURL(null, objectIdtag);
        var scenePath = kilroyURL(SCENE.idtag, objectIdtag);
        showMetadata(objectNametag, url, objectDescription, scenePath);
        updateBreadcrumb('objectNametag', scenePath, ' &gt; ' + objectNametag);
    }
    canonicalLocation(url, THING.nametag || SCENE.nametag);
    if (idvtagForHistory) {
        page(); // Only when adding to history. But see props().
        // KLUGE: requires selectedObjectPath to have already been set (by props).
        addHistory(objectIdtag, SCENE.timestamp, objectNametag, null, idvtagForHistory, undefined, selectedObjectPath);
    } // else title should have been set by loading or onpopstate.
    // IWBNI we disabled export off for whole scenes, as it could be a lot of data.
    document.getElementById('export').setAttribute('href',  '/xport/' + objectIdtag);
    updateLinksStyles();
    endUpdate();
}
// We implement tab selection with a 'selected' attribute because: 
// 1. :target css only works for one set of tabs at a time.
// 2. :target css won't allow us to initially select one of the tabs.
// 3. I don't know how broadly we can rely on css3.
function activateTab(id) {
    var newtab = document.getElementById(id), siblings = newtab.parentNode.childNodes, i, len = siblings.length, n;
    console.log('activateTab', id, newtab, newtab.className, 'eol');
    if (!isEnabled(newtab)) { return true; }
    for (i = 0; i < len; i++) { n = siblings[i]; if (n.setAttribute) { n.setAttribute('selected', n === newtab); } }
}
// plugin tells us what tab to display.
function tabSelect(idtag, cssClass) { // idtag is either 'metadata' or 'properties'
    cssClass = cssClass || 'htab';
    switch (idtag) {
    case 'properties': sendUnity('Avatar', 'StartGizmo', selectedObjectPath); break;
    case 'metadata': sendUnity('Avatar', 'StopGizmo', ''); break;
    case 'related': break;
    case 'history': break;
    }
    activateTab(idtag);
}

// showMetadata AND set expose that tab.
function showSocial(nametag, url, description, urlWithScene) {
    document.getElementById('details').value = ''; // so that showMetadata clears the detailsButton
    updateLinksStyles([showMetadata(nametag, url, description, urlWithScene)]);
    logEvent('discovery', 'social', url);
    tabSelect('metadata');
    // We could enable properties if the extended properties indicates that we are in the same scene.
    // If we change that, make sure that the geometric properties update as the object is adjusted! 
    // (and we can also at that time get rid of enable(document.getElementById('properties'), true) in softJump)
    enable(document.getElementById('properties'), false);
    var tab = document.getElementById('propertiesTab');
    tab.setAttribute('ktitle', tab.getAttribute('title'));
    tab.setAttribute('title', 'You have to go to this object before you can edit it.');
}
// During import, it is nice to give the user something to do (edit name/desc) before there is an object to link to.
// This could be a popup, but its nicer to:
//    show the user where the info will be used (in the public social metadata tab);
//    not cover the scene (or anything else) with a popup that needs to be dismissed through yet another user action;
//    leave the user at the social tab after import, so that the user can share (i.e., "publish") what they just did.
// We accomplish this by making a "fake" version of the metadata, in which the name/description are edit boxes.
// When we the object to edit actually exists and the scene is saved (which updates the metadata tab), the temporary
// values can be compared and resaved if nescessary. There's no point in having an onchange handler for the input elements
// before that, because there's no object to send those changes to.
// BUG: we do this for the first in a multi-drop. What happens if something other than the first is saved first? Need an id (other than f.name in case of 2 files w/same name)?
function showFakeSocial(nametag, description) {
    tabSelect('metadata');
    var lbl = document.getElementById('publicLabel'), dsc = document.getElementById('publicDesc');
    var tLbl = document.getElementById('tmpLabel'), tDsc = document.getElementById('tmpDesc');
    tLbl.value = tLbl.placeholder = nametag;
    tDsc.value = tDsc.placeholder = description;
    lbl.style.display = dsc.style.display = 'none';
    tLbl.style.display = tDsc.style.display = 'block';
    document.getElementById('spinnerOverlay').style.display = 'block';
    // Not sure it's worth resetting this (with the overla on top). Is that more confusing or less?
    updateSocial(kilroyURL(SCENE.idtag), nametag, lbl);
}

// Click handler for delete button.
function deleteObject() {  // Object must already be selected.
    if (selectedObjectPath === '/' + SCENE.idtag) { // see if we should delete the scene.
        if (document.getElementById('sceneUserNametag').getAttribute('href') === peopleURL(USER.idtag)) { // would maintaining a separate var be less fragile?
            if (confirm("You are welcome to have as many scenes as you want. If you really want to permanently delete '"
                        + SCENE.nametag + "', click 'OK', after which it cannot ever be recovered. Otherwise, click 'Cancel'.")) {
                updateUser({obsolete: SCENE.idtag}, function (err) {
                    if (err) {
                        errorMessage(err);
                    } else {
                        window.location = peopleURL(USER.idtag);
                    }
                });
            }
        } else {
            alert("This is not your scene, dude.");
        }
        return;
    }
    sendUnity(selectedObjectPath, 'deleteObject', 'ignored argument');
}
function onModified(e) { // mark the event target changed, so that updateVal doesn't overwrite.
    e = e || window.event;
    var node = e.target || e.srcElement;
    node.dataset.isChanged = selectedObjectPath;
    e.preventDefault();
}
function updateVal(id, val) { // Update the designated input element, unless it is has unsaved further changes
    var elt = document.getElementById(id);
    if (elt.dataset.isChanged !== selectedObjectPath) { elt.value = val; }
}
function makeTabStop(name, id, description, path) { // answer a draggable row
    var link = document.createElement('a');
    link.onclick = softLink;
    link.setAttribute('href', kilroyURL(SCENE.idtag, id));
    link.setAttribute('kilroyObjectPath', path);
    link.className = 'kilroyLink';
    link.innerHTML = name;
    var row = document.createElement('li');
    row.dataset.path = path;
    // For now, this is just distracting: row.innerHTML = '<img src="' + thumbnailURL(datum.idvtag) + '", height="50px"/>' + datum.nametag;
    row.appendChild(link);
    row.setAttribute('title', description);
    return row;
}
function makeTabStops(tabOrder) { // make the children of tabOrder draggable, with the appropriate actions, and answer the change event handler
    var onChanged = function () { // on drop
        var paths = [];
        _.each(tabOrder.childNodes, function (e) { paths.push(e.dataset.path); });
        tabOrder.dataset.isChanged = ''; // clear changed flag as we send to unity
        sendUnity('Avatar', 'setTabItems', JSON.stringify({paths: paths}));
    };
    makeReorderable(tabOrder.childNodes, onChanged, function () { // on drag, mark us changed
        tabOrder.dataset.isChanged = selectedObjectPath;
    });
    return onChanged;
}
function inTabOrder(tabOrder, pathToMatch) { // answer the node in the tab order list if present, otherwise null
    var nodes = tabOrder.childNodes, i, len = nodes.length, li, path;
    for (i = 0; i < len; i++) {
        li = nodes[i]; path = li.dataset.path;
        if (path === pathToMatch) { return li; }
    }
    return null;
}
// Used by plugin to set those object properties that only change with new selections.
function props(path, nametag, author, description, details, detailsLabel, tabOrderData, isFrozen) {
    console.log('props', path, nametag, author, description, details, detailsLabel, shorten(tabOrderData));
    // The plugin always sets props() when going to or away from an object. (The latter is to the scene.)
    // That will affect subsequent events (until set otherwise).
    dimension('scene', SCENE.idtag);
    dimension('author', author === USER.idtag ? 'self' : author);
    // However, the plugin only sets select() some of the time (and after props(), so the scene and author dims are set.
    // Alas, the plugin does not set select() on initial entry, and we would like to record that page hit.
    // So set it here if we're on first entry.
    if (!selectedObjectPath) {
        document.getElementById('export').setAttribute('href',  '/xport/' + (THING.idtag || SCENE.idtag)); // Set only in plugin initiated code, so that crawlers don't try to download zips.
        canonicalLocation(kilroyURL(SCENE.idtag, THING.idtag), THING.nametag || SCENE.nametag); // nametag arg will have 'Entry...'
        page();
        setTimeout(endUpdate, 0);
    }

    selectedObjectPath = path;
    document.getElementById('files').setAttribute('name', selectedObjectPath); // , name="files[]", 
    var geom = document.getElementById('geometry');
    var tabOrder = document.getElementById('tabOrder');
    var freeze = document.getElementById('freeze');
    if (tabOrderData) {
        if (tabOrder.dataset.isChanged !== selectedObjectPath) {
            geom.style.display = 'none';
            removeChildren(tabOrder);
            tabOrder.dataset.isChanged = '';
            JSON.parse(tabOrderData).forEach(function (datum) {
                var row = makeTabStop(datum.nametag, datum.idtag || datum.idvtag, datum.description, datum.path);
                tabOrder.appendChild(row);
            });
            makeTabStops(tabOrder);
            tabOrder.parentNode.style.display = 'block';
            freeze.parentNode.style.display = 'none';
        }
    } else {
        geom.style.display = 'block';
        tabOrder.parentNode.style.display = 'none';
        freeze.parentNode.style.display = 'block';
    }
    updateVal('desc', description);
    updateVal('tag0', nametag);
    updateVal('details', details);
    updateVal('detailsLabel', detailsLabel);
    if (freeze.dataset.isChanged !== selectedObjectPath) { freeze.checked = !!isFrozen; }
    updateDetailsDisplay(details, detailsLabel);
    setContent(document.getElementById('publicDesc'), description);
    document.getElementById('publicLabel').innerHTML = nametag;
    document.getElementById('tabstop').checked = !!inTabOrder(tabOrder, selectedObjectPath);
    enable(document.getElementById('properties'), true);
    var tab = document.getElementById('propertiesTab'), ktitle = tab.getAttribute('ktitle');
    if (ktitle) { tab.setAttribute('title', ktitle); tab.removeAttribute('ktitle'); }
}
function setTabstop(e) {
    e = e || window.event;
    var node = e.target || e.srcElement;
    var isChecked = node.checked;
    var tabOrder = document.getElementById('tabOrder');
    var row = inTabOrder(tabOrder, selectedObjectPath);
    var isRow = row !== null;
    console.log('setTabstop', isChecked, row);
    if (isChecked === isRow) { return; }
    if (isChecked) {
        tabOrder.appendChild(makeTabStop(THING.nametag, THING.idtag, document.getElementById('desc').value, selectedObjectPath));
    } else {
        tabOrder.removeChild(row);
    }
    makeTabStops(tabOrder)();
}
// A user can type as much precision as they need, but for most uses, it's much
// more helpful to trim the precision down so that the display is less imtimidating.
// This won't actually change the value unless someone changes the value (at which
// point, they can add or remove precision).
function updatePosition(posx, posy, posz) {  // New property data from plugin.
    updateVal('pos.x', units.fixed(posx));
    updateVal('pos.y', units.fixed(posy));
    updateVal('pos.z', units.fixed(posz));
}
function updateRotation(rotx, roty, rotz) {  // New property data from plugin.
    updateVal('rot.x', rotx.toFixed());
    updateVal('rot.y', roty.toFixed());
    updateVal('rot.z', rotz.toFixed());
}
function updateSize(sizex, sizey, sizez) { // New property data from plugin.
    updateVal('size.x', units.fixed(sizex));
    updateVal('size.y', units.fixed(sizey));
    updateVal('size.z', units.fixed(sizez));
}
function setFreeze(elt) {
    sendUnity(selectedObjectPath, 'setFreeze', elt.checked ? 'checked' : '');
    elt.dataset.isChanged = '';
}
function setProp(name, e, elementOverride, valOverride) { // Tells the plugin about properties form value changes
    e = e || window.event;
    var element = (e && e.target) || (e && e.srcElement) || elementOverride || this;
    var val = element ? element.value : valOverride;
    // There's no reason for any of these properties to be big, so let's not create display and overrun problems
    // for ourselves by allowing long strings.
    var limit = 256, label = "Strings";
    switch (name) {
    case 'setDesc':
        limit = 1024; label = "Descriptions"; break;
    case 'setDetails':
        limit = 1024; label = "Details"; break;
    case 'setPositionX':
    case 'setPositionY':
    case 'setPositionZ':
    case 'setSizeX':
    case 'setSizeY':
    case 'setSizeZ':
        val = units.from(parseFloat(val)).toString();
        break;
    }
    if (val.length && (val.length > limit)) {
        val = val.slice(0, limit);
        errorMessage(label + ' must be shorter than ' + limit + ' characters. Trimmed.');
    } else if ('number' === typeof val) {
        val = units.from(val);
    }
    element.dataset.isChanged = '';
    sendUnity(selectedObjectPath, name, val);
}
function setUnits(input) {
    var unitName = input.options[input.selectedIndex].value;
    var from = function (name) { return units.from(document.getElementById(name).value); };
    var posx = from('pos.x'), posy = from('pos.y'), posz = from('pos.z');
    var sizex = from('size.x'), sizey = from('size.y'), sizez = from('size.z');
    units = new Units(unitName);
    updatePosition(posx, posy, posz);
    updateSize(sizex, sizey, sizez);
    updateUser({units: unitName});
}
function toggleDetails() { // Opens or closes the details display.
    var details = document.getElementById('detailsDisplay');
    details.style.fontSize = (details.style.fontSize === "0px") ? "14px" : "0px";
}

/////////////////// Media Import /////////////////////
var kilroyMime = 'application/x-kilroy';
// See http://www.html5rocks.com/en/tutorials/file/dndfiles/

function importFiles(files) {  // Tell plugin about HTML5 files objects
    var i, f, unhandled = [], gotOne = false, action, reader;
    // Answers an onload handler for reading theFile as a data url.
    var loader = function (theFile, action) {
        return function (e) {
            sendUnity('Avatar', 'setImportFilename', theFile.name);
            // e.target.result is a url of the form: 'data:image/jpeg;base64xxxxxxx....'
            sendUnity('Avatar', action, e.target.result);
        };
    };
    // This will later have to be more sophisticated about related sets of files (e.g., a .mtl file and related images).
    for (i = 0, f = files[i]; i < files.length; i++) {
        action = '';
        if (f.size >= 1572864) {
            errorMessage("Files must be less than 1.5 MB in size. " + f.name + " is " + (f.size / 1048576.0).toFixed(1) + " Mega Bytes.");
            continue;
        }
        if (gotOne) {
            errorMessage("Files must be dropped one at a time.");
            break;
        }
        switch (f.type) {
        case 'image/jpeg':
        case 'image/png':
            if (!gotOne) {
                // It can take ~10 seconds to FileReader the data into Unity, scale it, encode as png, upload, and save the scene.
                // So do the following right now, at the earliest possible moment.
                showFakeSocial(f.name, "Picture imported into " + SCENE.nametag + " by " + USER.nametag + '.');
                gotOne = true; // If there's a set of files, we currently do this for just the first.
            }
            action = 'importImage';
            break;
        default:
            unhandled.push(f.type || '"unknown"');
        }
        if (action) {
            reader = new FileReader();
            reader.onload = loader(f, action);
            reader.readAsDataURL(f);
        }
    }
    if (unhandled.length) { errorMessage('Media types ' + unhandled.join(', ') + ' are not yet supported. Try .jpeg or .png images.'); }
}

function handleFileSelect(evt) { // change handler for file input button
    evt = evt || window.event;
    sendUnity('Avatar', 'setImportObject', selectedObjectPath); // compare 'setImportTarget', below.
    importFiles(evt.target.files);
    return finalHandler(evt);
}
function debugDrop(evt, msg) {
    var dt = evt.dataTransfer, i, len = dt.types.length, type, data, file, ftype;
    for (i = 0; i < len; i++) {
        type = dt.types[i];
        data = dt.getData(type);
        console.log(msg, 'drop type:', type, 'data:', data, 'eol');
    }
    var files = dt.files; len = files.length;
    for (i = 0; i < len; i++) {
        file = dt.files[i];
        ftype = file.type;
        console.log(msg, 'drop ftype:', ftype, 'file:', file, 'eol');
    }
}
// Sets drop coordinates within player. Asynchonous, and therefore needs post-setup action in a thunk.
function setupImportTarget(e, continuation) {
    restorePlayer();
    var x = e.offsetX, y = e.offsetY;
    var target = e.target || e.srcElement;
    if (x === undefined) { // e.g., firefox
        var rect = target.getBoundingClientRect();
        x = e.clientX - rect.left;
        y = e.clientY - rect.top;
    }
    // In browser/HTML, coordinates start at upper left. We want relative to lower left.
    var coord = x.toString() + 'x' + (target.clientHeight - y);
    setTimeout(function () { // give a little time to get the Unity Screen coords right after the above restorePlayer.
        sendUnity('Avatar', 'setImportTarget', coord);
        continuation();
    }, 20);
}
function handleDropSelect(evt) { // media drop handler
    evt = evt || window.event;
    var types = evt.dataTransfer.types;
    // Order matters, as Firefox supplies an empty Files type for x-kilroy.
    if (_.some(types, function (type) { return type === 'application/x-kilroy'; })) {
        var url = document.createElement('a');
        url.href = evt.dataTransfer.getData('application/x-kilroy');
        var prefix = '/things/';
        if (url.pathname.indexOf(prefix) === 0) {
            setupImportTarget(evt, function () {
                sendUnity('Avatar', 'importThing', url.pathname.slice(prefix.length));
            });
        } else {
            selectedObjectPath = null; // so that new props() updates things
            restorePlayer();
            sendUnity('Avatar', 'copyScene', url.pathname.slice(('/places/').length));
        }
    } else if (_.some(types, function (type) { return type.match('Files'); })) {
        var files = evt.dataTransfer.files; // evt and dataTransfer won't survive the setTimeout in setupImportTarget.
        setupImportTarget(evt, function () {
            importFiles(files);
        });
    } else {
        debugDrop(evt, 'handleDropSelect');
        errorMessage('Only files, or thumbnails within Kilroy, may be dropped into a scene.');
    }
    return finalHandler(evt);
}
function handleDragOver(evt) {  // media drag handler -- Give user feedback.
    evt = evt || window.event;
    // It would be nice if this declared things were not droppable, ...
    evt.dataTransfer.dropEffect = 'copy'; // Explicitly show this is a copy.
    // ... but either way, do absorb the drop because we don't want people trying things that fail and being sent to a different page.
    return finalHandler(evt);
}
