xdescribe('kilroy', function () {
	var isObjectInScene = ~document.location.search.indexOf('__G1');
	var objectTestLabel = isObjectInScene ? 'has' : 'does not have';
	var objectExpect = function (val) {
		var expectation = expect(val);
		return isObjectInScene ? expectation : expectation.not;
	};
	var sceneTitle = 'TestScene';  // Maybe conditionalize these on document.location.href or route parameters?
	var objectTitle = 'Tall Block';
	var sceneId = 'G1';
	beforeEach(function () { waitsFor(function () { return SCENE_NAMETAG; }, 'sceneName set', 10000); });
	it('has scene name in document.title', function () {
		expect(document.title).toContain(sceneTitle);
	});
	it(objectTestLabel + ' object name in document.title', function () {
		objectExpect(document.title).toContain(objectTitle);
	});
	it(objectTestLabel + ' scene idtag in email link', function () {
		objectExpect(document.getElementById('email').getAttribute('href')).toContain('__' + sceneId);
	});
	describe('text stream', function () {
		it('has system message', function () {
			var msg = document.getElementsByClassName('imMessage').item(0);
			expect(msg.firstElementChild.innerHTML).toBe('Kilroy');
			expect(msg.lastChild.textContent).toContain('This is unsupported, experimental software!');
		});
		it('accepts and shows text input', function () {
			var inputElt = document.getElementById('input');
			var txt = 'hello, world!';
			var nMsgs = document.getElementsByClassName('imMessage').length;
			var msgs;
			inputElt.value = txt;
			inputElt.onkeypress({keyCode: 13});
			expect(inputElt.value).toBe('');
			waitsFor(function () { return (msgs = document.getElementsByClassName('imMessage')).length > nMsgs; }, 'message to arrive', 10000);
			runs(function () { expect(msgs.item(msgs.length - 1).lastChild.textContent).toContain(txt); });
		});
	});
	var testReady, makeSpinner = function (body, iterateTest, finalTest, iterateDelay) {
		// Answers a thunk that executes body() and then waits until iterateTest() before
		// either the next iteration, or, if finalTest(), setting testReady and exiting.
		var iterateTime = iterateDelay || 1000;
		var thisSpinner = function () {
			body();
			var checker = function () {
				if (!iterateTest()) {
					setTimeout(checker, iterateTime);
				} else if (finalTest()) {
					testReady = true;
				} else {
					thisSpinner();
				}
			};
			checker();
		};
		return function () { testReady = false; thisSpinner(); };
	}, waiter = function () { return testReady; };
	xdescribe('history', function () {
		var titles = [];
		it('can tab through scene', function () {
			var firstTitle, lastTitle;
			runs(makeSpinner(function () {
				if (~document.title.indexOf(objectTitle)) { firstTitle = document.title; }
				lastTitle = document.title;
				titles.push(document.title);
				sendUnity('Avatar', 'Next', 'true');
			}, function () {
				return document.title !== lastTitle;
			}, function () {
				return document.title === firstTitle;
			}));
			waitsFor(waiter, 'tab test to finish', 15000);
			runs(function () { console.log('titles', titles); expect(titles.length).toBeGreaterThan(0); });
		});
		it('can go back through history', function () {
			var lastTitle, expectedTitle;
			runs(makeSpinner(function () {
				if (expectedTitle) { expect(document.title).toBe(expectedTitle); }
				lastTitle = document.title;
				expectedTitle = titles.pop();
				history.back();
			}, function () {
				return document.title !== lastTitle;
			}, function () {
				return !titles.length;
			}));
			waitsFor(waiter, 'back test to finish', 15000);
			runs(function () {
				console.log('done', titles, history.state, history.length);
				if (isObjectInScene) {
					expect(history.state ? history.state.title : document.title).toBe(document.title);
				} else {
					expect(history.state).toBeFalsy();
					expect(document.title).toContain(sceneTitle);
					expect(document.title).not.toContain(objectTitle);
				}
			});
		});
	});
});
