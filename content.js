(function () {
	'use strict';

	const SPEEDS = [1, 1.5, 2, 3];
	const ROOT_ID = 'yts-speed-root';
	const VIDEO_HOOK_KEY = 'bmYts3xHooked';
	const CONTROLLER_ATTR = 'data-bm-yts-controller';
	const SPEED_STORAGE_KEY = 'bmYts3xSpeed';
	const STORAGE_KEY_DEFAULT_SPEED_INDEX = 'bmYts3xOptsDefaultSpeedIndex';
	const STORAGE_KEY_HOLD_SPEED_INDEX = 'bmYts3xOptsHoldSpeedIndex';
	let mainTickInterval = null;

	function isToolboxControllerActive() {
		return document.documentElement.getAttribute(CONTROLLER_ATTR) === 'toolbox';
	}

	function t(key) {
		try {
			const msg = chrome.i18n.getMessage(key);
			if (msg) return msg;
		} catch (_) {}
		return key;
	}

	let currentIndex = 0;
	let holdActive = false;
	let holdPointerId = null;
	let holdSpeedIndex = 2;

	function readSessionIndex() {
		try {
			const raw = sessionStorage.getItem(SPEED_STORAGE_KEY);
			if (raw === null || raw === '') return null;
			const value = Number(raw);
			if (!Number.isFinite(value)) return null;
			return Math.max(0, Math.min(SPEEDS.length - 1, Math.floor(value)));
		} catch (_) {
			return null;
		}
	}

	function clampSpeedIndex(i) {
		const n = Number(i);
		if (!Number.isFinite(n)) return 0;
		return Math.max(0, Math.min(SPEEDS.length - 1, Math.floor(n)));
	}

	function persistSpeedIndex() {
		try {
			sessionStorage.setItem(SPEED_STORAGE_KEY, String(currentIndex));
		} catch (_) {}
	}

	function getEffectivePlaybackRate() {
		return SPEEDS[holdActive ? holdSpeedIndex : currentIndex];
	}

	function initStorageBackedOptions() {
		try {
			chrome.storage.local.get(
				{
					[STORAGE_KEY_DEFAULT_SPEED_INDEX]: 0,
					[STORAGE_KEY_HOLD_SPEED_INDEX]: 2,
				},
				(res) => {
					if (chrome.runtime.lastError) return;
					holdSpeedIndex = clampSpeedIndex(res[STORAGE_KEY_HOLD_SPEED_INDEX]);
					const sess = readSessionIndex();
					if (sess !== null) {
						currentIndex = sess;
					} else {
						currentIndex = clampSpeedIndex(res[STORAGE_KEY_DEFAULT_SPEED_INDEX]);
						persistSpeedIndex();
					}
					if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
					applyToAllLikelyVideos();
				}
			);
		} catch (_) {}
	}

	try {
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return;
			if (changes[STORAGE_KEY_HOLD_SPEED_INDEX]) {
				holdSpeedIndex = clampSpeedIndex(changes[STORAGE_KEY_HOLD_SPEED_INDEX].newValue);
				if (holdActive) applyToAllLikelyVideos();
			}
			if (changes[STORAGE_KEY_DEFAULT_SPEED_INDEX]) {
				currentIndex = clampSpeedIndex(changes[STORAGE_KEY_DEFAULT_SPEED_INDEX].newValue);
				persistSpeedIndex();
				if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
				applyToAllLikelyVideos();
			}
		});
	} catch (_) {}

	let mountObserver = null;
	let videoObserver = null;
	let reapplyTimer = null;
	let speedRootEl = null;

	const SHADOW_STYLES = `
#${ROOT_ID}{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:48px;margin-bottom:16px;flex-shrink:0;pointer-events:auto}
#${ROOT_ID} .yts-speed-btn{box-sizing:border-box;width:48px;height:48px;padding:0;margin:0;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:13px;font-weight:600;line-height:1;letter-spacing:-0.02em;color:var(--yt-spec-text-primary,#fff);background-color:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1));backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:filter .12s ease,transform .1s ease}
#${ROOT_ID} .yts-speed-btn:hover{filter:brightness(1.14)}
#${ROOT_ID} .yts-speed-btn:active{filter:brightness(.92);transform:scale(.96)}
#${ROOT_ID} .yts-speed-caption{margin-top:6px;max-width:56px;text-align:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:12px;font-weight:400;line-height:1.2;color:var(--yt-spec-text-secondary,rgba(255,255,255,.9));white-space:nowrap}
`;

	function findNativeLikeButtonForStyle() {
		const scope = getShortsReelUiScopeRoot();
		if (!scope) return null;
		const ref =
			querySelectorDeep(
				'#segmented-like-button button.yt-spec-button-shape-next--segmented-start',
				scope
			) ||
			querySelectorDeep(
				'segmented-like-dislike-button-view-model segmented-like-button button.yt-spec-button-shape-next',
				scope
			) ||
			querySelectorDeep(
				'segmented-like-dislike-button-view-model button.yt-spec-button-shape-next--segmented-start',
				scope
			) ||
			querySelectorDeep('#like-button button.yt-spec-button-shape-next', scope) ||
			querySelectorDeep('like-button-view-model button.yt-spec-button-shape-next', scope);
		if (!ref || !isInReelActionUi(ref)) return null;
		return ref;
	}

	function syncSpeedUiWithNativeLike() {
		const root = speedRootEl;
		if (!root || !root.isConnected) return;
		const btn = root.querySelector('.yts-speed-btn');
		const cap = root.querySelector('.yts-speed-caption');
		if (!(btn instanceof HTMLButtonElement)) return;

		const ref = findNativeLikeButtonForStyle();
		if (!ref || !ref.isConnected) {
			btn.style.removeProperty('background-color');
			btn.style.removeProperty('color');
			if (cap instanceof HTMLElement) cap.style.removeProperty('color');
			return;
		}

		if (ref.getAttribute('aria-pressed') === 'true') {
			btn.style.removeProperty('background-color');
			btn.style.removeProperty('color');
			if (cap instanceof HTMLElement) cap.style.removeProperty('color');
			return;
		}

		const cs = getComputedStyle(ref);
		let bg = cs.backgroundColor;
		if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
			const fill = ref.querySelector('.yt-spec-touch-feedback-shape__fill');
			if (fill instanceof HTMLElement) {
				bg = getComputedStyle(fill).backgroundColor;
			}
		}
		if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
			btn.style.backgroundColor = bg;
		}
		const fg = cs.color;
		if (fg) {
			btn.style.color = fg;
			if (cap instanceof HTMLElement) cap.style.color = fg;
		}
	}

	function getSpeed() {
		return SPEEDS[currentIndex];
	}

	function findSpeedIndexByRate(rate) {
		for (let i = 0; i < SPEEDS.length; i++) {
			if (Math.abs(SPEEDS[i] - rate) < 0.01) return i;
		}
		return -1;
	}

	function syncIndexFromObservedRate(rate) {
		if (holdActive) return false;
		const idx = findSpeedIndexByRate(rate);
		if (idx < 0 || idx === currentIndex) return false;
		currentIndex = idx;
		persistSpeedIndex();
		if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
		return true;
	}

	function formatSpeedLabel(s) {
		if (Number.isInteger(s)) return `${s}×`;
		const t = String(s).replace(/\.0+$/, '');
		return `${t}×`;
	}

	function querySelectorDeep(selector, base = document.documentElement) {
		if (!base) return null;
		const stack = [base];
		while (stack.length) {
			const node = stack.pop();
			if (!node) continue;
			if (node instanceof Element) {
				try {
					if (node.matches(selector)) return node;
					const hit = node.querySelector(selector);
					if (hit) return hit;
				} catch (_) {}
				if (node.shadowRoot) stack.push(node.shadowRoot);
				for (let i = node.children.length - 1; i >= 0; i--) {
					stack.push(node.children[i]);
				}
			} else if (node instanceof ShadowRoot) {
				try {
					const hit = node.querySelector(selector);
					if (hit) return hit;
				} catch (_) {}
				for (let i = node.children.length - 1; i >= 0; i--) {
					stack.push(node.children[i]);
				}
			}
		}
		return null;
	}

	function isInsideCommentsPanel(el) {
		if (!el) return false;
		return !!el.closest(
			'ytd-comments-panel, ytd-engagement-panel, ytd-engagement-panel-section, ytd-comment-renderer, ytd-comment-thread-renderer, ytd-comment-simplebox-renderer, ytd-comment-action-buttons-renderer, #engagement-panel'
		);
	}

	function isInReelActionUi(el) {
		if (!el) return false;
		if (isInsideCommentsPanel(el)) return false;
		return !!(el.closest('ytd-reel-player-overlay-renderer') || el.closest('#shorts-player'));
	}

	function getShortsReelUiScopeRoot() {
		const overlay =
			document.querySelector('ytd-reel-player-overlay-renderer') ||
			querySelectorDeep('ytd-reel-player-overlay-renderer', document.documentElement);
		if (overlay && !isInsideCommentsPanel(overlay)) return overlay;

		const sp =
			document.querySelector('#shorts-player') ||
			querySelectorDeep('#shorts-player', document.documentElement);
		if (sp && !isInsideCommentsPanel(sp)) return sp;

		return null;
	}

	function ensureStylesInShadowRoot(shadowRoot) {
		if (!(shadowRoot instanceof ShadowRoot)) return;
		if (shadowRoot.querySelector('#yts-speed-style')) return;
		const s = document.createElement('style');
		s.id = 'yts-speed-style';
		s.textContent = SHADOW_STYLES;
		shadowRoot.prepend(s);
	}

	function findDirectFlexChild(column, inner) {
		let x = inner;
		while (x && x.parentElement && x.parentElement !== column) {
			x = x.parentElement;
		}
		return x;
	}

	function findLikeRowElement(likeInner) {
		if (!likeInner) return null;
		const byItem =
			likeInner.closest('reel-action-bar-item-view-model') ||
			likeInner.closest('reel-action-bar-item-renderer');
		if (byItem && byItem.parentElement) return byItem;

		let n = likeInner;
		for (let depth = 0; depth < 28 && n; depth++) {
			const p = n.parentElement;
			if (!p) break;
			const cs = getComputedStyle(p);
			if (
				cs.display.includes('flex') &&
				(cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse')
			) {
				const direct = findDirectFlexChild(p, likeInner);
				if (direct) return direct;
			}
			n = p;
		}
		return null;
	}

	function attachRootAboveLikeRow(root, likeRow) {
		const column = likeRow.parentElement;
		if (!column) return false;
		column.insertBefore(root, likeRow);
		const rn = root.getRootNode();
		if (rn instanceof ShadowRoot) {
			ensureStylesInShadowRoot(rn);
		}
		if (getComputedStyle(column).flexDirection === 'column-reverse') {
			const rr = root.getBoundingClientRect();
			const lr = likeRow.getBoundingClientRect();
			if (!(rr.top < lr.top)) {
				if (likeRow.nextSibling) {
					column.insertBefore(root, likeRow.nextSibling);
				} else {
					column.appendChild(root);
				}
				if (!(root.getBoundingClientRect().top < likeRow.getBoundingClientRect().top)) {
					column.insertBefore(root, likeRow);
				}
			}
		}
		return true;
	}

	function ensureSpeedAnchorIntact() {
		if (!speedRootEl || !speedRootEl.isConnected) return;
		if (!isInReelActionUi(speedRootEl)) {
			speedRootEl.remove();
			speedRootEl = null;
			return;
		}
		const likeInner = findLikeInner();
		if (!likeInner || !likeInner.isConnected) return;
		const likeRow = findLikeRowElement(likeInner);
		if (!likeRow || !likeRow.parentElement) return;
		const column = likeRow.parentElement;
		if (speedRootEl.parentElement !== column || speedRootEl.nextSibling !== likeRow) {
			attachRootAboveLikeRow(speedRootEl, likeRow);
		}
	}

	function getActiveShortsVideo() {
		const selectors = ['ytd-reel-video-renderer video', 'ytd-shorts video', '#shorts-player video'];
		const seen = new Set();
		const candidates = [];
		for (const sel of selectors) {
			document.querySelectorAll(sel).forEach((v) => {
				if (v instanceof HTMLVideoElement && !seen.has(v)) {
					seen.add(v);
					candidates.push(v);
				}
			});
		}
		let best = null;
		let bestScore = 0;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		for (const v of candidates) {
			const r = v.getBoundingClientRect();
			const iw = Math.min(r.right, vw) - Math.max(r.left, 0);
			const ih = Math.min(r.bottom, vh) - Math.max(r.top, 0);
			const area = Math.max(0, iw) * Math.max(0, ih);
			const centerX = (r.left + r.right) / 2;
			const centerDist = Math.abs(centerX - vw / 2) / vw;
			const score = area * (1 - centerDist * 0.35);
			if (score > bestScore) {
				bestScore = score;
				best = v;
			}
		}
		return best;
	}

	function applyPlaybackRateTo(video) {
		if (!video) return;
		const rate = getEffectivePlaybackRate();
		try {
			video.playbackRate = rate;
			video.defaultPlaybackRate = rate;
		} catch (_) {}
	}

	function applyToAllLikelyVideos() {
		const primary = getActiveShortsVideo();
		applyPlaybackRateTo(primary);
		const rate = getEffectivePlaybackRate();
		document.querySelectorAll('ytd-reel-video-renderer video').forEach((v) => {
			if (v === primary) return;
			try {
				if (!v.paused) {
					v.playbackRate = rate;
					v.defaultPlaybackRate = rate;
				}
			} catch (_) {}
		});
	}

	function scheduleReapply() {
		if (reapplyTimer) clearTimeout(reapplyTimer);
		reapplyTimer = setTimeout(() => {
			reapplyTimer = null;
			applyToAllLikelyVideos();
		}, 50);
	}

	function cycleSpeed() {
		currentIndex = (currentIndex + 1) % SPEEDS.length;
		persistSpeedIndex();
		if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
		applyToAllLikelyVideos();
	}

	let btnLabel = null;

	function findLikeInner() {
		const scope = getShortsReelUiScopeRoot();
		if (!scope) return null;
		const hit =
			querySelectorDeep('#like-button', scope) ||
			querySelectorDeep('like-button-view-model', scope) ||
			querySelectorDeep('segmented-like-dislike-button-view-model', scope);
		if (!hit || !isInReelActionUi(hit)) return null;
		return hit;
	}

	function ensureMounted() {
		if (speedRootEl && speedRootEl.isConnected) return true;

		const likeInner = findLikeInner();
		if (!likeInner || !likeInner.isConnected) return false;

		const root = document.createElement('div');
		root.id = ROOT_ID;
		root.setAttribute('data-yts-speed', '1');

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'yts-speed-btn';
		btn.setAttribute('aria-label', t('ariaPlaybackSpeed'));
		btnLabel = document.createElement('span');
		btnLabel.textContent = formatSpeedLabel(getSpeed());
		btn.appendChild(btnLabel);
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			cycleSpeed();
		});

		const caption = document.createElement('span');
		caption.className = 'yts-speed-caption';
		caption.textContent = t('captionSpeed');

		root.appendChild(btn);
		root.appendChild(caption);

		const likeRow = findLikeRowElement(likeInner);
		if (likeRow && likeRow.parentElement) {
			attachRootAboveLikeRow(root, likeRow);
		} else {
			const host = likeInner.closest('reel-action-bar-item-view-model') || likeInner.parentElement;
			if (!host || !host.parentElement) return false;
			host.parentElement.insertBefore(root, host);
		}

		const rn = root.getRootNode();
		speedRootEl = root;
		ensureStylesInShadowRoot(rn);
		syncSpeedUiWithNativeLike();
		applyToAllLikelyVideos();
		return true;
	}

	function teardownVideoHooks() {
		if (videoObserver) {
			videoObserver.disconnect();
			videoObserver = null;
		}
	}

	function stopSelfForToolboxTakeover() {
		if (mountObserver) {
			mountObserver.disconnect();
			mountObserver = null;
		}
		teardownVideoHooks();
		if (mainTickInterval) {
			clearInterval(mainTickInterval);
			mainTickInterval = null;
		}
		if (speedRootEl && speedRootEl.isConnected) {
			speedRootEl.remove();
		}
		speedRootEl = null;
	}

	function hookVideoElement(v) {
		if (!(v instanceof HTMLVideoElement) || v.dataset[VIDEO_HOOK_KEY]) return;
		v.dataset[VIDEO_HOOK_KEY] = '1';
		v.addEventListener('ratechange', () => {
			const want = getEffectivePlaybackRate();
			if (Math.abs(v.playbackRate - want) > 0.01) {
				applyPlaybackRateTo(v);
			}
		});
		v.addEventListener('loadedmetadata', scheduleReapply);
		v.addEventListener('playing', scheduleReapply);
	}

	function hookAllVideosUnder(root) {
		root.querySelectorAll('video').forEach(hookVideoElement);
	}

	function setupVideoHooks() {
		teardownVideoHooks();
		const shortsRoot =
			document.querySelector('ytd-shorts') ||
			document.querySelector('#shorts-container') ||
			document.body;
		hookAllVideosUnder(shortsRoot);
		videoObserver = new MutationObserver((muts) => {
			for (const m of muts) {
				m.addedNodes.forEach((n) => {
					if (n instanceof HTMLVideoElement) hookVideoElement(n);
					else if (n instanceof Element) hookAllVideosUnder(n);
				});
			}
			scheduleReapply();
		});
		videoObserver.observe(shortsRoot, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['hidden', 'class', 'style'],
		});
	}

	function shouldStartHold(e) {
		if (isToolboxControllerActive()) return false;
		if (!e.isPrimary) return false;
		if (e.pointerType === 'mouse' && e.button !== 0) return false;
		const t = e.target;
		if (!(t instanceof Element)) return false;
		if (t.closest('input, textarea, select, [contenteditable="true"]')) return false;
		if (t.closest('#' + ROOT_ID)) return false;
		if (isInsideCommentsPanel(t)) return false;
		if (
			t.closest('#actions, ytd-reel-player-overlay-renderer #actions, reel-action-bar-item-view-model')
		)
			return false;

		const v = getActiveShortsVideo();
		if (!v) return false;
		const x = e.clientX;
		const y = e.clientY;
		const r = v.getBoundingClientRect();
		if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;

		const actions = document.querySelector('ytd-reel-player-overlay-renderer #actions');
		if (actions) {
			const ar = actions.getBoundingClientRect();
			if (x >= ar.left && x <= ar.right && y >= ar.top && y <= ar.bottom) return false;
		}
		return true;
	}

	const HOLD_ACTIVATE_MS = 200;

	let holdListenersInstalled = false;
	function installHoldListeners() {
		if (holdListenersInstalled) return;
		holdListenersInstalled = true;

		let pendingPointerId = null;
		let pendingTimer = null;

		function tearDownReleaseListeners() {
			window.removeEventListener('pointerup', onRelease, true);
			window.removeEventListener('pointercancel', onRelease, true);
			window.removeEventListener('blur', onBlurWhilePendingOrHold, false);
		}

		function suppressSyntheticClickAfterHold() {
			function blockClick(ev) {
				ev.preventDefault();
				ev.stopImmediatePropagation();
				document.removeEventListener('click', blockClick, true);
			}
			document.addEventListener('click', blockClick, true);
		}

		function deactivateHoldPlayback() {
			if (!holdActive) return;
			holdActive = false;
			holdPointerId = null;
			applyToAllLikelyVideos();
		}

		function activateHoldPlayback(pid) {
			holdActive = true;
			holdPointerId = pid;
			applyToAllLikelyVideos();
		}

		function cancelPendingHold() {
			if (pendingTimer !== null) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			pendingPointerId = null;
		}

		function onBlurWhilePendingOrHold() {
			cancelPendingHold();
			tearDownReleaseListeners();
			deactivateHoldPlayback();
		}

		function onRelease(e) {
			if (pendingPointerId === null) return;
			if (e && e.pointerId !== undefined && e.pointerId !== pendingPointerId) return;

			const hadAccelerated = holdActive;

			cancelPendingHold();
			tearDownReleaseListeners();

			if (hadAccelerated) {
				deactivateHoldPlayback();
				suppressSyntheticClickAfterHold();
			}
		}

		document.documentElement.addEventListener(
			'pointerdown',
			(e) => {
				if (holdActive || pendingPointerId !== null) return;
				if (!shouldStartHold(e)) return;

				pendingPointerId = e.pointerId;
				pendingTimer = setTimeout(() => {
					pendingTimer = null;
					activateHoldPlayback(pendingPointerId);
				}, HOLD_ACTIVATE_MS);

				window.addEventListener('pointerup', onRelease, true);
				window.addEventListener('pointercancel', onRelease, true);
				window.addEventListener('blur', onBlurWhilePendingOrHold, false);
			},
			true
		);
	}

	function initObservers() {
		if (mountObserver) mountObserver.disconnect();
		mountObserver = new MutationObserver(() => {
			if (!(speedRootEl && speedRootEl.isConnected)) {
				speedRootEl = null;
				if (ensureMounted()) setupVideoHooks();
			} else {
				ensureSpeedAnchorIntact();
				scheduleReapply();
			}
		});
		mountObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});
	}

	function tick() {
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		if (!ensureMounted()) return;
		ensureSpeedAnchorIntact();
		if (!videoObserver) setupVideoHooks();
		scheduleReapply();
		syncSpeedUiWithNativeLike();
	}

	if (isToolboxControllerActive()) {
		return;
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', tick);
	} else {
		tick();
	}
	initObservers();
	mainTickInterval = setInterval(tick, 2000);
	initStorageBackedOptions();
	installHoldListeners();
})();
