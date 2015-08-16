"use strict";
/*jslint browser: true, devel: true, vars: true, forin: true, plusplus: true, nomen: true */
/// Common utilities used by Kilroy.
/// Copyright (c) 2013 Beyond My Wall. All rights reserved until we get a clue.

var ActiveXObject;

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// We don't yet use the whole underscore library, but where we do use utilities that are similar to underscores, at 
// least use compatabile names and behavior. Simples thing first, though: we're not concerned here about duplicating
// additional underscore behavior that we don't make use of.
var _ = {};
_.noop = function noop() { };  // Just one place for jslint to complain about.
_.contains = function contains(sequence, subsequence) { // true iff sequence contains subsequence
    return ~sequence.indexOf(subsequence);
};
_.each = function each(sequence, iterator, optionalContext) { // forEach that works on NodeList
    return [].forEach.call(sequence, iterator, optionalContext);
};
_.indexOf = function indexOf(sequence, target) { // indexOf that works on NodeList
    return [].indexOf.call(sequence, target);
};
_.map = function map(sequence, iterator, optionalContext) { // map that works on NodeList
    return [].map.call(sequence, iterator, optionalContext);
};
_.some = function some(sequence, iterator, optionalContext) { // some that works on NodeList
    return [].some.call(sequence, iterator, optionalContext);
};
// Trim string to no more than length (at an optionalDelimiter), including appended optionalEllipsis.
// Note that this is different than underscore.string.truncate, which doesn't respect word boundaries.
// Our version takes an optinalDelimiter, although we don't use it anywhere...
_.prune = function prune(string, length, optionalEllipsis, optionalDelimiter) {
    if (string.length <= length) { return string; }
    optionalDelimiter = optionalDelimiter || ' ';
    string = string.substr(0, length + optionalDelimiter.length);
    var lastDelimIndex = string.lastIndexOf(optionalDelimiter);
    if (lastDelimIndex >= 0) { string = string.substr(0, lastDelimIndex); }
    if (string) { string += (optionalEllipsis === undefined) ? '...' : optionalEllipsis; }
    return string;
};
function shorten(x, limit) { // Elide the middle of x if necessary. Useful for logging.
    limit = limit || 60;
    var half = Math.floor(limit / 2);
    return x ? (x.length > limit ? x.slice(0, half) + ' ... ' + x.slice(-half) : x) : x;
}
if (!String.prototype.trim) { // I expect there's no point, as we would fail in other ways on any browser old enough to not not have this.
    String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ''); };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// The functions get and post create asynchornous XMLHttpRequests, with function(err, parsedAsJsonObject) callbacks.
function request() { // shim for XMLHttpRequest
    if (window.XMLHttpRequest) { return new XMLHttpRequest(); }
    // IE6, IE5, ...
    return new ActiveXObject("Microsoft.XMLHTTP");
}
function makeOnload(xmlhttp, callback) { // if callback, assign an onload handler that will do callback(err, parsedObject)
    if (!callback) { return; }
    xmlhttp.onload = function () {
        var ok = (xmlhttp.status === 200);
        callback(!ok && request.statusText, ok && JSON.parse(xmlhttp.responseText));
    };
}
// Posts a paramsObject (map of params to values) to the given url.
function post(url, paramsObject, optionalCallback) {
    var xmlhttp = request();
    makeOnload(xmlhttp, optionalCallback);
    xmlhttp.open("POST", url, true);
    xmlhttp.setRequestHeader("Content-type", "application/json");
    var paramString = JSON.stringify(paramsObject);
    xmlhttp.send(paramString);
}
// Get a kilroy resource.
function get(url, callback) {
    var xmlhttp = request();
    makeOnload(xmlhttp, callback);
    xmlhttp.open("GET", url, true);
    xmlhttp.send();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// DOM shims.
function finalHandler(evt) { // Call in a handler to stop any further action
    if (!evt) { return; }
    if (evt.stopPropagation) { evt.stopPropagation(); }
    if (evt.preventDefault) { evt.preventDefault(); }
    return false;
}

// Make all draggables elements reorderable by dragging within their parentNode.
// (The draggables can be an element list instead of a proper array.)
// As each element is dragged over, the class overAbove, overBelow, or both are added.
// One typically wants to also style the elements with cursor move, but that's the consumer's job.
// If optionalCallback is supplied, it is called after the drop, with the dropped item as arg.
function makeReorderable(draggables, optionalDropCallback, optionalDragCallback) {
    var dragSrcEl = null;  // The element being dragged
    var dragIndex;         // Its index within its parent.
    // These two because some DOM sequences are not proper arrays:
    var nodeIndex = function (elt) { return _.indexOf(elt.parentNode.childNodes, elt); };
    var doDraggables = function (cb) { _.each(draggables, cb); };
    var removeAffordanceClasses = function (elt) {
        elt.classList.remove('overAbove');
        elt.classList.remove('overBelow');
    };
    doDraggables(function (elt) { // Side effect each draggable with correct handlers.
        elt.setAttribute('draggable', true);
        elt.classList.add('reorderable');
        var handle = function (event, handler) { elt.addEventListener(event, handler, false); };
        handle('dragstart',  function (e) { // this/e.target is the source node.
            dragSrcEl = this;
            dragIndex = nodeIndex(this);
            this.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
            if (optionalDragCallback) { optionalDragCallback(this); }
        });
        handle('dragenter', function () {   // this/e.target is the current hover target.
            var index = nodeIndex(this); // add either or both affordance classes.
            if (index <= dragIndex) { this.classList.add('overAbove'); }
            if (index >= dragIndex) { this.classList.add('overBelow'); }
        });
        handle('dragover', function (e) {
            if (e.preventDefault) { e.preventDefault(); } // required to allow drop
            e.dataTransfer.dropEffect = 'move';
            return false;
        });
        handle('dragleave', function () { removeAffordanceClasses(this); });
        handle('dragend', function () { doDraggables(removeAffordanceClasses); });
        handle('drop', function (e) { // this/e.target is current target element.
            if (e.stopPropagation) { e.stopPropagation(); } // stops the browser from redirecting.
            dragSrcEl.style.opacity = '1.0';
            var index = nodeIndex(this), beforeElt = null;
            if (index === dragIndex) { return false; }
            if (index < dragIndex) {
                beforeElt = this;
            } else {
                beforeElt = this.nextSibling;
            }
            console.log('drop', e, index, this, 'src', dragSrcEl, dragIndex, beforeElt);
            this.parentNode.insertBefore(dragSrcEl, beforeElt);
            if (optionalDropCallback) { optionalDropCallback(this); }
            return false;
        });
    });
}
