(function () {
	'use strict';

	const SPEEDS = [1, 1.5, 2, 3];
	const ROOT_ID = 'yts-speed-root';
	const SPEED_BUTTON_Z = '4';
	const VIDEO_HOOK_KEY = 'bmYts3xHooked';
	const CONTROLLER_ATTR = 'data-bm-yts-controller';
	const TOOLBOX_ROLE = 'toolbox';
	const SPEED_ROLE = 'speed';
	const SPEED_STORAGE_KEY = 'bmYts3xSpeed';
	const STORAGE_KEY_DEFAULT_SPEED_INDEX = 'bmYts3xOptsDefaultSpeedIndex';
	const STORAGE_KEY_HOLD_SPEED_INDEX = 'bmYts3xOptsHoldSpeedIndex';
	let mainTickInterval = null;
	const hookedVideos = new Map();
	let resizeLayoutTimer = null;

	function isLiveToolboxUi() {
		if (document.querySelector(`#${ROOT_ID} .yts-toolbox-panel`)) return true;
		if (document.querySelector(`#${ROOT_ID}[data-bm-yts-role="${TOOLBOX_ROLE}"]`)) return true;
		return false;
	}

	function isToolboxControllerActive() {
		if (isLiveToolboxUi()) return true;
		return document.documentElement.getAttribute(CONTROLLER_ATTR) === TOOLBOX_ROLE;
	}

	function clearStaleToolboxControllerAttr() {
		if (document.documentElement.getAttribute(CONTROLLER_ATTR) !== TOOLBOX_ROLE) return;
		if (isLiveToolboxUi()) return;
		document.documentElement.removeAttribute(CONTROLLER_ATTR);
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

	function persistDefaultSpeedIndex() {
		try {
			chrome.storage.local.set({
				[STORAGE_KEY_DEFAULT_SPEED_INDEX]: currentIndex,
			});
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
					applyToActiveShortsVideo();
				}
			);
		} catch (_) {}
	}

	try {
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return;
			if (changes[STORAGE_KEY_HOLD_SPEED_INDEX]) {
				holdSpeedIndex = clampSpeedIndex(changes[STORAGE_KEY_HOLD_SPEED_INDEX].newValue);
				if (holdActive) applyToActiveShortsVideo();
			}
			if (changes[STORAGE_KEY_DEFAULT_SPEED_INDEX]) {
				const next = clampSpeedIndex(changes[STORAGE_KEY_DEFAULT_SPEED_INDEX].newValue);
				if (next === currentIndex) return;
				currentIndex = next;
				persistSpeedIndex();
				if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
				applyToActiveShortsVideo();
			}
		});
	} catch (_) {}

	let mountObserver = null;
	let videoObserver = null;
	let reapplyTimer = null;
	let mutatingDom = 0;
	let mountDebounceTimer = null;
	let lastMountWorkAt = 0;
	let scopeCache = null;
	let scopeCacheAt = 0;
	let scopeCacheShortId = '';
	let speedRootEl = null;

	const SHADOW_STYLES = `
#${ROOT_ID}{--bm-btn-size:48px;--bm-btn-bg:rgba(255,255,255,.1);--bm-btn-fg:#fff;--bm-btn-backdrop:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:var(--bm-btn-size);margin-bottom:0;flex-shrink:0;pointer-events:auto;position:relative;z-index:4}
#${ROOT_ID}[data-bm-theme="light"]{--bm-btn-bg:rgba(0,0,0,.05);--bm-btn-fg:#0f0f0f}
#${ROOT_ID}[data-bm-overlay-dark]{--bm-btn-bg:rgba(0,0,0,.3);--bm-btn-fg:#fff;--bm-btn-backdrop:none}
#${ROOT_ID} .yts-speed-btn{box-sizing:border-box;width:var(--bm-btn-size);height:var(--bm-btn-size);padding:0;margin:0;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:13px;font-weight:600;line-height:1;letter-spacing:-0.02em;color:var(--bm-btn-fg,#fff);background-color:var(--bm-btn-bg,rgba(255,255,255,.1));backdrop-filter:var(--bm-btn-backdrop,blur(8px));-webkit-backdrop-filter:var(--bm-btn-backdrop,blur(8px));transition:background-color .12s ease;position:relative;overflow:hidden}
#${ROOT_ID} .yts-speed-btn::after{content:"";position:absolute;inset:0;border-radius:inherit;background:transparent;pointer-events:none}
#${ROOT_ID}[data-bm-theme="dark"] .yts-speed-btn{color:var(--bm-btn-fg,#fff);background-color:var(--bm-btn-bg,rgba(255,255,255,.1))}
#${ROOT_ID}[data-bm-theme="light"] .yts-speed-btn{color:var(--bm-btn-fg,#0f0f0f);background-color:var(--bm-btn-bg,rgba(0,0,0,.05))}
#${ROOT_ID}[data-bm-overlay-dark] .yts-speed-btn{color:var(--bm-btn-fg,#fff);background-color:var(--bm-btn-bg,rgba(0,0,0,.3));backdrop-filter:none;-webkit-backdrop-filter:none}
#${ROOT_ID} .yts-speed-btn:hover{filter:none;background-color:var(--bm-btn-bg,rgba(255,255,255,.1))}
#${ROOT_ID} .yts-speed-btn:hover::after{background:rgba(255,255,255,.1)}
#${ROOT_ID}[data-bm-theme="light"]:not([data-bm-overlay-dark]) .yts-speed-btn:hover::after{background:rgba(0,0,0,.06)}
#${ROOT_ID} .yts-speed-btn:active{filter:none;transform:none}
#${ROOT_ID} .yts-speed-btn:active::after{background:rgba(255,255,255,.16)}
#${ROOT_ID} .yts-speed-caption{margin-top:6px;max-width:56px;text-align:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:12px;font-weight:400;line-height:1.2;white-space:nowrap;position:relative;z-index:1}
#${ROOT_ID}[data-bm-theme="dark"] .yts-speed-caption{color:#fff}
#${ROOT_ID}[data-bm-theme="light"] .yts-speed-caption{color:#0f0f0f}
#${ROOT_ID}[data-bm-overlay-dark] .yts-speed-caption{color:#fff}
`;

	function isYouTubeDarkTheme() {
		const html = document.documentElement;
		if (html && (html.hasAttribute('dark') || html.getAttribute('dark') === 'true')) {
			return true;
		}
		const ytdApp = document.querySelector('ytd-app');
		if (ytdApp instanceof HTMLElement) {
			if (ytdApp.hasAttribute('dark') || ytdApp.getAttribute('dark') === 'true') return true;
		}
		return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	}

	function parseCssColor(s) {
		if (!s) return null;
		const m = String(s).match(
			/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i
		);
		if (!m) return null;
		let a = m[4] === undefined ? 1 : Number(m[4]);
		if (a > 1) a /= 100;
		return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
	}

	function looksLightFrost(bg) {
		const c = parseCssColor(bg);
		return !!(c && c.r > 160 && c.g > 160 && c.b > 160 && c.a > 0.02 && c.a <= 0.28);
	}

	function looksDarkFill(bg) {
		const c = parseCssColor(bg);
		return !!(c && c.r < 48 && c.g < 48 && c.b < 48 && c.a >= 0.18);
	}

	function getThemeFallbacks(overlayDark) {
		if (overlayDark) {
			return { btnBg: 'rgba(0, 0, 0, 0.3)', btnFg: '#fff', captionFg: '#fff', backdrop: 'none' };
		}
		if (isYouTubeDarkTheme()) {
			return {
				btnBg: 'rgba(255, 255, 255, 0.1)',
				btnFg: '#fff',
				captionFg: '#fff',
				backdrop: 'blur(8px)',
			};
		}
		return {
			btnBg: 'rgba(0, 0, 0, 0.05)',
			btnFg: '#0f0f0f',
			captionFg: '#0f0f0f',
			backdrop: 'blur(8px)',
		};
	}

	function nativeButtonLooksOverlayDark(btn) {
		if (!(btn instanceof HTMLElement)) return false;
		if (btn.matches(':hover') || btn.matches(':active')) return false;
		const bg = readVisibleBackground(btn);
		if (looksLightFrost(bg)) return false;
		if (looksDarkFill(bg)) return true;
		const cls = `${btn.className || ''} ${btn.getAttribute('class') || ''}`;
		return /OverlayDark|overlay-dark/i.test(cls);
	}

	function readVisibleColor(el) {
		if (!(el instanceof HTMLElement)) return '';
		const cs = getComputedStyle(el);
		const color = cs.color;
		if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
		return '';
	}

	function readVisibleBackground(el) {
		if (!(el instanceof HTMLElement)) return '';
		if (el.matches(':hover') || el.matches(':active')) return '';
		const cs = getComputedStyle(el);
		let bg = cs.backgroundColor;
		const parsed = parseCssColor(bg);
		if (parsed && parsed.a > 0.02) return bg;
		const fill = el.querySelector(
			'.yt-spec-touch-feedback-shape__fill, .ytSpecTouchFeedbackShapeFill'
		);
		if (fill instanceof HTMLElement && !fill.matches(':hover')) {
			bg = getComputedStyle(fill).backgroundColor;
			const fillParsed = parseCssColor(bg);
			if (fillParsed && fillParsed.a > 0.02) return bg;
		}
		return '';
	}

	function findNativeLikeCaptionElement() {
		const likeInner = findLikeInner();
		if (!likeInner) return null;
		const row = findLikeRowElement(likeInner);
		if (!(row instanceof HTMLElement)) return null;
		const nodes = row.querySelectorAll(
			'yt-formatted-string, .yt-core-attributed-string, .yt-spec-button-shape-next__button-text-content, span'
		);
		for (const el of nodes) {
			if (!(el instanceof HTMLElement)) continue;
			if (el.closest('button')) continue;
			if (!(el.textContent || '').trim()) continue;
			return el;
		}
		return null;
	}

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
			querySelectorDeep('like-button-view-model button.ytSpecButtonShapeNextHost', scope) ||
			querySelectorDeep('#like-button button.yt-spec-button-shape-next', scope) ||
			querySelectorDeep('like-button-view-model button.yt-spec-button-shape-next', scope) ||
			querySelectorDeep('like-button-view-model button', scope);
		if (!ref || !isInReelActionUi(ref)) return null;
		return ref;
	}

	function syncSpeedUiWithNativeLike() {
		const root = speedRootEl;
		if (!root || !root.isConnected) return;
		const btn = root.querySelector('.yts-speed-btn');
		const cap = root.querySelector('.yts-speed-caption');
		if (!(btn instanceof HTMLButtonElement)) return;

		const dark = isYouTubeDarkTheme();
		const ref = findNativeLikeButtonForStyle();
		const overlayDark = nativeButtonLooksOverlayDark(ref);
		root.setAttribute('data-bm-theme', dark ? 'dark' : 'light');
		root.toggleAttribute('data-bm-overlay-dark', overlayDark);

		const fallbacks = getThemeFallbacks(overlayDark);
		let btnBg = fallbacks.btnBg;
		let btnFg = fallbacks.btnFg;
		let capFg = fallbacks.captionFg;
		let backdrop = fallbacks.backdrop;

		if (ref && ref.isConnected && !ref.matches(':hover') && !ref.matches(':active')) {
			const nativeBg = readVisibleBackground(ref);
			const nativeFg = readVisibleColor(ref);
			const nativeBackdrop =
				getComputedStyle(ref).backdropFilter || getComputedStyle(ref).webkitBackdropFilter || '';
			if (nativeBg) btnBg = nativeBg;
			if (nativeFg) btnFg = nativeFg;
			if (overlayDark) backdrop = 'none';
			else if (nativeBackdrop && nativeBackdrop !== 'none') backdrop = nativeBackdrop;
		} else if (overlayDark) {
			backdrop = 'none';
		}

		const captionEl = findNativeLikeCaptionElement();
		const nativeCapFg = readVisibleColor(captionEl);
		if (nativeCapFg) capFg = nativeCapFg;

		root.style.setProperty('--bm-btn-bg', btnBg);
		root.style.setProperty('--bm-btn-fg', btnFg);
		root.style.setProperty('--bm-btn-backdrop', backdrop);
		btn.style.removeProperty('background-color');
		btn.style.removeProperty('color');
		if (cap instanceof HTMLElement) cap.style.color = capFg;
	}

	function getSpeed() {
		return SPEEDS[currentIndex];
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

	function querySelectorAllDeep(selector, base = document.documentElement) {
		if (!base) return [];
		const out = [];
		const seen = new Set();
		const stack = [base];
		while (stack.length) {
			const node = stack.pop();
			if (!node) continue;
			if (node instanceof Element || node instanceof ShadowRoot) {
				try {
				node.querySelectorAll(selector).forEach((el) => {
					if (!seen.has(el)) {
						seen.add(el);
						out.push(el);
					}
				});
			} catch (_) {}
			}
			if (node instanceof Element) {
				if (node.shadowRoot) stack.push(node.shadowRoot);
				for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
			} else if (node instanceof ShadowRoot) {
				for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
			}
		}
		return out;
	}

	function closestAcrossShadow(startEl, selector) {
		let node = startEl;
		while (node) {
			if (node instanceof Element) {
				try {
					if (node.matches(selector)) return node;
				} catch (_) {}
			}
			if (node instanceof Element && node.parentElement) {
				node = node.parentElement;
				continue;
			}
			const root = node.getRootNode?.();
			if (root instanceof ShadowRoot && root.host) {
				node = root.host;
				continue;
			}
			break;
		}
		return null;
	}

	function isInsideCommentsPanel(el) {
		if (!el) return false;
		return !!el.closest(
			'ytd-comments-panel, ytd-engagement-panel, ytd-engagement-panel-section, ytd-engagement-panel-section-list-renderer[target-id*="comment"], ytd-comment-renderer, ytd-comment-thread-renderer, ytd-comment-simplebox-renderer, ytd-comment-action-buttons-renderer, [target-id="engagement-panel-comments-section"], #engagement-panel'
		);
	}

	function isInReelActionUi(el) {
		if (!el) return false;
		if (speedRootEl && (el === speedRootEl || (el instanceof Node && speedRootEl.contains(el)))) {
			return true;
		}
		if (isInsideCommentsPanel(el)) return false;
		return !!closestAcrossShadow(
			el,
			'ytd-reel-player-overlay-renderer, ytd-reel-player-overlay-renderer-cow, yt-reel-player-overlay-view-model, reel-action-bar-view-model, #shorts-player'
		);
	}

	function beginDomMutation() {
		mutatingDom += 1;
	}

	function endDomMutation() {
		mutatingDom = Math.max(0, mutatingDom - 1);
	}

	function isDomMutating() {
		return mutatingDom > 0;
	}

	function invalidateScopeCache() {
		scopeCache = null;
		scopeCacheAt = 0;
		scopeCacheShortId = '';
	}

	function getShortsReelUiScopeRoot() {
		const now = Date.now();
		const currentShortId = getCurrentShortId();
		if (
			scopeCache &&
			scopeCache.isConnected &&
			scopeCacheShortId === currentShortId &&
			now - scopeCacheAt < 500
		) {
			return scopeCache;
		}
		if (scopeCacheShortId !== currentShortId) invalidateScopeCache();

		// New Shorts markup places the action bar beside the player rather than
		// inside ytd-reel-player-overlay-renderer or #shorts-player.
		let bestActionBar = null;
		let bestActionBarScore = -1;
		let bestUrlMatchedActionBar = null;
		let bestUrlMatchedActionBarScore = -1;
		for (const actionBar of querySelectorAllDeep('reel-action-bar-view-model')) {
			if (!(actionBar instanceof HTMLElement) || isInsideCommentsPanel(actionBar)) continue;
			const r = actionBar.getBoundingClientRect();
			if (r.width < 24 || r.height < 24 || r.right <= 0 || r.left >= window.innerWidth) continue;
			if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
			const visibleArea =
				Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)) *
				Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
			const score = visibleArea * (1.2 - Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2) / window.innerHeight);
			if (score > bestActionBarScore) {
				bestActionBar = actionBar;
				bestActionBarScore = score;
			}
			const renderer = closestAcrossShadow(actionBar, 'ytd-reel-video-renderer');
			if (
				currentShortId &&
				renderer instanceof HTMLElement &&
				shortIdFromHost(renderer) === currentShortId &&
				score > bestUrlMatchedActionBarScore
			) {
				bestUrlMatchedActionBar = actionBar;
				bestUrlMatchedActionBarScore = score;
			}
		}
		if (bestUrlMatchedActionBar) {
			scopeCache = bestUrlMatchedActionBar;
			scopeCacheAt = now;
			scopeCacheShortId = currentShortId;
			return bestUrlMatchedActionBar;
		}
		if (bestActionBar) {
			scopeCache = bestActionBar;
			scopeCacheAt = now;
			scopeCacheShortId = currentShortId;
			return bestActionBar;
		}

		for (const o of querySelectorAllDeep(
			'ytd-reel-player-overlay-renderer, ytd-reel-player-overlay-renderer-cow, yt-reel-player-overlay-view-model'
		)) {
			if (!(o instanceof HTMLElement) || isInsideCommentsPanel(o)) continue;
			const r = o.getBoundingClientRect();
			if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.top >= window.innerHeight) continue;
			if (
				o.querySelector(
					'#actions, #like-button, like-button-view-model, segmented-like-dislike-button-view-model, reel-action-bar-view-model'
				)
			) {
				scopeCache = o;
				scopeCacheAt = now;
				scopeCacheShortId = currentShortId;
				return o;
			}
		}

		const overlay = querySelectorDeep(
			'ytd-reel-player-overlay-renderer, ytd-reel-player-overlay-renderer-cow, yt-reel-player-overlay-view-model'
		);
		if (overlay instanceof HTMLElement && !isInsideCommentsPanel(overlay)) {
			scopeCache = overlay;
			scopeCacheAt = now;
			scopeCacheShortId = currentShortId;
			return overlay;
		}

		const sp = querySelectorDeep('#shorts-player');
		if (sp instanceof HTMLElement && !isInsideCommentsPanel(sp)) {
			scopeCache = sp;
			scopeCacheAt = now;
			scopeCacheShortId = currentShortId;
			return sp;
		}

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
			closestAcrossShadow(likeInner, 'reel-action-bar-item-view-model') ||
			closestAcrossShadow(likeInner, 'reel-action-bar-item-renderer');
		if (byItem && byItem.parentElement) return byItem;

		const bar =
			closestAcrossShadow(likeInner, 'reel-action-bar-view-model') ||
			closestAcrossShadow(likeInner, '#actions');
		if (bar) {
			const tagged = closestAcrossShadow(
				likeInner,
				'like-button-view-model, segmented-like-dislike-button-view-model, button-view-model'
			);
			if (tagged instanceof HTMLElement) {
				let row = tagged;
				for (let depth = 0; depth < 32 && row !== bar; depth++) {
					if (row.parentElement === bar) return row;
					if (row.parentElement) {
						row = row.parentElement;
						continue;
					}
					const root = row.getRootNode();
					if (!(root instanceof ShadowRoot)) break;
					if (root.host === bar) return row;
					row = root.host;
				}
			}
		}

		const actionsBoundary = bar || closestAcrossShadow(likeInner, '#actions');
		let n = likeInner;
		for (let depth = 0; depth < 28 && n; depth++) {
			const p = n.parentElement;
			if (!p) break;
			if (actionsBoundary && !actionsBoundary.contains(p)) break;
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

	function isSpeedOnBodyHost(root = speedRootEl) {
		return !!(
			root instanceof HTMLElement &&
			root.isConnected &&
			root.dataset.ytsFixedHost === '1' &&
			(root.parentElement === document.body || root.parentElement === document.documentElement)
		);
	}

	function isOnScreenActionRect(rect) {
		if (!rect) return false;
		if (!(rect.width >= 24 && rect.height >= 24)) return false;
		if (rect.right <= 8 || rect.bottom <= 8) return false;
		if (rect.left >= window.innerWidth - 8 || rect.top >= window.innerHeight - 8) return false;
		return true;
	}

	function isMastheadGhostRect(rect) {
		if (!rect) return true;
		return rect.left < 72 && rect.top < 80;
	}

	function isButtonSizedActionRect(rect) {
		if (!isOnScreenActionRect(rect) || isMastheadGhostRect(rect)) return false;
		if (rect.width > 140 || rect.height > 180) return false;
		return true;
	}

	function isUsableActionAnchorRect(rect) {
		return isButtonSizedActionRect(rect);
	}

	function isVisibleNativeRailButton(btn) {
		if (!(btn instanceof HTMLElement)) return false;
		if (speedRootEl && speedRootEl.contains(btn)) return false;
		if (!isInReelActionUi(btn)) return false;
		const rect = btn.getBoundingClientRect();
		if (!isButtonSizedActionRect(rect)) return false;
		const style = getComputedStyle(btn);
		return style.display !== 'none' && style.visibility !== 'hidden';
	}

	function findVisibleNativeLikeButton() {
		const scoped = findNativeLikeButtonForStyle();
		if (isVisibleNativeRailButton(scoped)) return scoped;
		const nodes = querySelectorAllDeep(
			'like-button-view-model button, #like-button button, segmented-like-button-view-model button, reel-action-bar-view-model button'
		);
		let best = null;
		let bestScore = -1;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		for (const btn of nodes) {
			if (!(btn instanceof HTMLElement) || !isVisibleNativeRailButton(btn)) continue;
			const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`;
			const host = btn.closest(
				'like-button-view-model, #like-button, segmented-like-button-view-model'
			);
			if (!host && !/(like|喜歡|点赞|讚|いいね)/i.test(label)) continue;
			const rect = btn.getBoundingClientRect();
			const visibleArea =
				Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) *
				Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
			const score = visibleArea * (1.2 - Math.abs((rect.top + rect.bottom) / 2 - vh / 2) / vh);
			if (score > bestScore) {
				best = btn;
				bestScore = score;
			}
		}
		return best;
	}

	function measureNativeRailPitch(btn) {
		if (!(btn instanceof HTMLElement)) return 92;
		const row = findLikeRowElement(btn);
		const rail = row?.parentElement || btn.closest('reel-action-bar-view-model, #actions');
		if (!(rail instanceof HTMLElement)) return 92;
		const buttons = Array.from(rail.children)
			.map((child) => child.querySelector?.('button'))
			.filter((child) => child instanceof HTMLElement);
		const index = buttons.findIndex((candidate) => candidate === btn || candidate.contains(btn));
		const next = index >= 0 ? buttons[index + 1] : null;
		if (next instanceof HTMLElement) {
			const pitch = next.getBoundingClientRect().top - btn.getBoundingClientRect().top;
			if (pitch >= 56 && pitch <= 180) return pitch;
		}
		return 92;
	}

	function getRowAnchorRect(row) {
		if (!(row instanceof HTMLElement)) return null;
		const rr = row.getBoundingClientRect();
		if (isButtonSizedActionRect(rr) && rr.height >= 56) return rr;
		const btn = row.querySelector('button');
		if (btn instanceof HTMLElement) {
			const br = btn.getBoundingClientRect();
			if (isButtonSizedActionRect(br)) {
				const pitch = 92;
				return {
					left: br.left,
					top: br.top,
					width: br.width,
					height: pitch,
					right: br.left + br.width,
					bottom: br.top + pitch,
				};
			}
		}
		return isButtonSizedActionRect(rr) ? rr : null;
	}

	function speedHasStableFixedPosition(root) {
		if (!(root instanceof HTMLElement)) return false;
		const left = parseFloat(root.style.left);
		const top = parseFloat(root.style.top);
		const width = parseFloat(root.style.width) || 48;
		const height = parseFloat(root.style.height) || 48;
		if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
		if (left <= -1000 || top <= -1000) return false;
		return isUsableActionAnchorRect({
			left,
			top,
			width,
			height,
			right: left + width,
			bottom: top + height,
		});
	}

	function syncSpeedLayoutWithNative() {
		const root = speedRootEl;
		if (!(root instanceof HTMLElement) || !root.isConnected) return;
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		const likeBtn = findVisibleNativeLikeButton();
		if (!(likeBtn instanceof HTMLElement)) {
			if (!speedHasStableFixedPosition(root)) root.style.visibility = 'hidden';
			return;
		}
		const likeRow = findLikeRowElement(likeBtn) || likeBtn;
		if (!attachRootAtLikeRow(root, likeRow)) {
			if (!speedHasStableFixedPosition(root)) root.style.visibility = 'hidden';
			return;
		}
		const likeRect = likeBtn.getBoundingClientRect();
		const pitch = measureNativeRailPitch(likeBtn);
		root.style.visibility = 'visible';
		root.style.setProperty('position', 'relative', 'important');
		root.style.setProperty('left', '0px', 'important');
		root.style.setProperty('top', '0px', 'important');
		root.style.setProperty('width', `${Math.round(likeRect.width)}px`, 'important');
		root.style.setProperty('height', `${pitch}px`, 'important');
		root.style.setProperty('margin', '0px', 'important');
		root.style.setProperty('z-index', SPEED_BUTTON_Z, 'important');
		root.style.setProperty('pointer-events', 'auto', 'important');
		const size = Math.round(Math.max(likeRect.width, likeRect.height));
		if (Number.isFinite(size) && size >= 32) {
			root.style.setProperty('--bm-btn-size', `${size}px`);
		}
	}
	function attachRootAtLikeRow(root, likeRow) {
		if (!(root instanceof HTMLElement) || !(likeRow instanceof HTMLElement)) return false;
		if (likeRow.contains(root) || root.contains(likeRow)) return false;
		const actionBar = closestAcrossShadow(likeRow, 'reel-action-bar-view-model, #actions');
		const rowRoot = likeRow.getRootNode();
		const parent =
			rowRoot instanceof ShadowRoot && actionBar instanceof HTMLElement && rowRoot.host === actionBar
				? rowRoot
				: actionBar instanceof HTMLElement
					? actionBar
					: likeRow.parentElement;
		if (!(parent instanceof Node)) return false;
		beginDomMutation();
		try {
			// Put the speed control in the native action rail's first visual slot,
			// ahead of optional account-specific actions such as Gemini.
			const reverse =
				parent instanceof Element && getComputedStyle(parent).flexDirection === 'column-reverse';
			parent.insertBefore(root, reverse ? null : parent.firstElementChild);
			ensureStylesInShadowRoot(root.getRootNode());
			delete root.dataset.ytsFixedHost;
			root.dataset.bmYtsRole = SPEED_ROLE;
			root.style.setProperty('position', 'relative', 'important');
			root.style.setProperty('left', '0px', 'important');
			root.style.setProperty('top', '0px', 'important');
		} finally {
			endDomMutation();
		}
		return root.isConnected;
	}
	function findFirstActionBarRow(scope) {
		if (!(scope instanceof HTMLElement)) return null;
		const actionRoots = [
			scope.querySelector('#actions'),
			scope.querySelector('reel-action-bar-view-model'),
			scope.querySelector('.ytReelPlayerOverlayViewModelActionsContainer'),
		].filter((root) => root instanceof HTMLElement);
		for (const actions of actionRoots) {
			for (const child of actions.children) {
				if (!(child instanceof HTMLElement)) continue;
				if (!isInReelActionUi(child)) continue;
				const btn = child.querySelector('button');
				if (!(btn instanceof HTMLButtonElement)) continue;
				return findLikeRowElement(btn) || child;
			}
		}
		return null;
	}

	function findMountAnchorRow() {
		const likeInner = findLikeInner();
		if (likeInner && likeInner.isConnected) {
			const likeRow = findLikeRowElement(likeInner);
			if (likeRow) return likeRow;
		}
		return findFirstActionBarRow(getShortsReelUiScopeRoot());
	}

	function ensureSpeedAnchorIntact() {
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		if (!speedRootEl || !speedRootEl.isConnected) return;
		const likeBtn = findVisibleNativeLikeButton();
		if (!(likeBtn instanceof HTMLElement)) return;
		const likeRow = findLikeRowElement(likeBtn) || likeBtn;
		attachRootAtLikeRow(speedRootEl, likeRow);
		syncSpeedLayoutWithNative();
	}
	function getActiveShortsVideo() {
		const selectors = ['ytd-reel-video-renderer video', 'ytd-shorts video', '#shorts-player video'];
		const seen = new Set();
		const candidates = [];
		for (const sel of selectors) {
			querySelectorAllDeep(sel).forEach((v) => {
				if (v instanceof HTMLVideoElement && !seen.has(v)) {
					seen.add(v);
					candidates.push(v);
				}
			});
		}
		const urlId = getCurrentShortId();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let bestUrlMatch = null;
		let bestUrlScore = -1;
		let bestActive = null;
		let bestActiveScore = -1;
		let bestVisible = null;
		let bestVisibleScore = -1;
		for (const v of candidates) {
			const r = v.getBoundingClientRect();
			const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
			const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
			const area = iw * ih;
			if (area <= 0) continue;
			const centerX = (r.left + r.right) / 2;
			const centerY = (r.top + r.bottom) / 2;
			const score = area * (1 - Math.abs(centerX - vw / 2) / vw * 0.35) *
				(1 - Math.abs(centerY - vh / 2) / vh * 0.2);
			if (score > bestVisibleScore) {
				bestVisible = v;
				bestVisibleScore = score;
			}
			const renderer = closestAcrossShadow(v, 'ytd-reel-video-renderer');
			if (!(renderer instanceof HTMLElement)) continue;
			if (urlId && shortIdFromHost(renderer) === urlId && score > bestUrlScore) {
				bestUrlMatch = v;
				bestUrlScore = score;
			}
			const active = renderer.hasAttribute('is-active') || renderer.hasAttribute('reel-active') ||
				renderer.getAttribute('aria-hidden') === 'false';
			if (active && score > bestActiveScore) {
				bestActive = v;
				bestActiveScore = score;
			}
		}
		return bestUrlMatch || bestActive || bestVisible;
	}

	function getCurrentShortId() {
		const match = location.pathname.match(/^\/shorts\/([^/?#]+)/);
		return match && match[1] ? match[1] : '';
	}

	function shortIdFromHost(host) {
		if (!(host instanceof HTMLElement)) return '';
		const renderer =
			host.tagName === 'YTD-REEL-VIDEO-RENDERER'
				? host
				: closestAcrossShadow(host, 'ytd-reel-video-renderer') ||
					querySelectorDeep('ytd-reel-video-renderer', host);
		if (renderer instanceof HTMLElement) {
			for (const id of [
				renderer.getAttribute('id'),
				renderer.getAttribute('reel-video-id'),
				renderer.getAttribute('video-id'),
				renderer.dataset.videoId,
			]) {
				if (id && id !== 'short' && id !== 'reel-video-renderer') return id;
			}
			for (const link of querySelectorAllDeep('a[href*="/shorts/"]', renderer)) {
				if (!(link instanceof HTMLAnchorElement)) continue;
				if (link.closest('yt-reel-carousel-view-model, .ytReelCarouselViewModelHost')) continue;
				if (/\/hashtag\//i.test(link.getAttribute('href') || '')) continue;
				const match = `${link.getAttribute('href') || ''} ${link.href || ''}`.match(
					/\/shorts\/([^/?#]+)/
				);
				if (match && match[1]) return match[1];
			}
			for (const el of querySelectorAllDeep(
				'[src*="/vi/"], [srcset*="/vi/"], [style*="/vi/"]',
				renderer
			)) {
				const blob = `${el.getAttribute('src') || ''} ${el.getAttribute('srcset') || ''} ${
					el.getAttribute('style') || ''
				}`;
				const match = blob.match(/\/vi\/([^/]+)\//);
				if (match && match[1]) return match[1];
			}
		}
		return '';
	}

	function applyPlaybackRateTo(video) {
		if (!video) return;
		const rate = getEffectivePlaybackRate();
		try {
			video.playbackRate = rate;
			video.defaultPlaybackRate = rate;
		} catch (_) {}
	}

	function applyToActiveShortsVideo() {
		if (isToolboxControllerActive()) return;
		applyPlaybackRateTo(getActiveShortsVideo());
	}

	function scheduleReapply() {
		if (reapplyTimer) clearTimeout(reapplyTimer);
		reapplyTimer = setTimeout(() => {
			reapplyTimer = null;
			if (isToolboxControllerActive()) return;
			applyToActiveShortsVideo();
		}, 50);
	}

	function cycleSpeed() {
		currentIndex = (currentIndex + 1) % SPEEDS.length;
		persistSpeedIndex();
		persistDefaultSpeedIndex();
		if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
		applyToActiveShortsVideo();
	}

	let btnLabel = null;

	function findLikeByAriaFallback(scope) {
		if (!(scope instanceof HTMLElement)) return null;
		const actions = scope.querySelector('#actions');
		if (!(actions instanceof HTMLElement)) return null;
		for (const btn of querySelectorAllDeep('button', actions)) {
			if (!(btn instanceof HTMLButtonElement)) continue;
			const label = (
				btn.getAttribute('aria-label') ||
				btn.getAttribute('title') ||
				btn.textContent ||
				''
			).toLowerCase();
			if (!/(like|喜歡|喜歡這|点赞|讚|いいね)/i.test(label)) continue;
			return (
				btn.closest('#like-button') ||
				btn.closest('like-button-view-model') ||
				btn.closest('segmented-like-dislike-button-view-model') ||
				btn
			);
		}
		return null;
	}

	function findLikeInner() {
		const scope = getShortsReelUiScopeRoot();
		if (!scope) return null;
		const hit =
			scope.querySelector('#like-button') ||
			scope.querySelector('like-button-view-model') ||
			scope.querySelector('segmented-like-dislike-button-view-model') ||
			querySelectorDeep('#like-button', scope) ||
			querySelectorDeep('like-button-view-model', scope) ||
			querySelectorDeep('segmented-like-dislike-button-view-model', scope) ||
			findLikeByAriaFallback(scope);
		if (!hit || !isInReelActionUi(hit)) return null;
		return hit;
	}

	function ensureMounted() {
		if (isToolboxControllerActive()) return false;
		if (speedRootEl && speedRootEl.isConnected) return true;

		const likeBtn = findVisibleNativeLikeButton();
		if (!(likeBtn instanceof HTMLElement)) return false;

		const root = document.createElement('div');
		root.id = ROOT_ID;
		root.setAttribute('data-yts-speed', '1');
		root.dataset.bmYtsRole = SPEED_ROLE;
		root.style.visibility = 'hidden';
		root.style.setProperty('position', 'fixed', 'important');
		root.style.setProperty('left', '-9999px', 'important');
		root.style.setProperty('top', '-9999px', 'important');

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

		if (!attachRootAtLikeRow(root, findLikeRowElement(likeBtn) || likeBtn)) return false;

		speedRootEl = root;
		syncSpeedUiWithNativeLike();
		syncSpeedLayoutWithNative();
		applyToActiveShortsVideo();
		return true;
	}

	function teardownVideoHooks() {
		if (videoObserver) {
			videoObserver.disconnect();
			videoObserver = null;
		}
		for (const [video, handlers] of hookedVideos) {
			video.removeEventListener('ratechange', handlers.ratechange);
			video.removeEventListener('loadedmetadata', handlers.scheduleReapply);
			video.removeEventListener('playing', handlers.scheduleReapply);
			delete video.dataset[VIDEO_HOOK_KEY];
		}
		hookedVideos.clear();
	}

	function stopSelfForToolboxTakeover() {
		disconnectMountObserver();
		if (mountDebounceTimer) {
			clearTimeout(mountDebounceTimer);
			mountDebounceTimer = null;
		}
		teardownVideoHooks();
		if (speedRootEl && speedRootEl.isConnected) {
			speedRootEl.remove();
		}
		speedRootEl = null;
	}

	function hookVideoElement(v) {
		if (!(v instanceof HTMLVideoElement) || v.dataset[VIDEO_HOOK_KEY]) return;
		v.dataset[VIDEO_HOOK_KEY] = '1';
		const handlers = {
			ratechange: () => {
				if (isToolboxControllerActive() || getActiveShortsVideo() !== v) return;
				const want = getEffectivePlaybackRate();
				if (Math.abs(v.playbackRate - want) > 0.01) {
					applyPlaybackRateTo(v);
				}
			},
			scheduleReapply,
		};
		hookedVideos.set(v, handlers);
		v.addEventListener('ratechange', handlers.ratechange);
		v.addEventListener('loadedmetadata', handlers.scheduleReapply);
		v.addEventListener('playing', handlers.scheduleReapply);
	}

	function unhookVideoElement(v) {
		const handlers = hookedVideos.get(v);
		if (!handlers) return;
		v.removeEventListener('ratechange', handlers.ratechange);
		v.removeEventListener('loadedmetadata', handlers.scheduleReapply);
		v.removeEventListener('playing', handlers.scheduleReapply);
		hookedVideos.delete(v);
		delete v.dataset[VIDEO_HOOK_KEY];
	}

	function unhookAllVideosUnder(node) {
		if (node instanceof HTMLVideoElement) unhookVideoElement(node);
		if (node instanceof Element) node.querySelectorAll('video').forEach(unhookVideoElement);
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
				m.removedNodes.forEach(unhookAllVideosUnder);
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
			t.closest(
				'#actions, ytd-reel-player-overlay-renderer #actions, reel-action-bar-view-model, reel-action-bar-item-view-model, .ytReelPlayerOverlayViewModelActionsContainer'
			)
		)
			return false;

		const v = getActiveShortsVideo();
		if (!v) return false;
		const x = e.clientX;
		const y = e.clientY;
		const r = v.getBoundingClientRect();
		if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;

		const actions =
			document.querySelector('ytd-reel-player-overlay-renderer reel-action-bar-view-model') ||
			document.querySelector('ytd-reel-player-overlay-renderer #actions');
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
			applyToActiveShortsVideo();
		}

		function activateHoldPlayback(pid) {
			holdActive = true;
			holdPointerId = pid;
			applyToActiveShortsVideo();
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

	function disconnectMountObserver() {
		if (!mountObserver) return;
		mountObserver.disconnect();
		mountObserver = null;
	}

	function runMountPass() {
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		const mounted = ensureMounted();
		if (mounted) disconnectMountObserver();
		if (!mounted) return;
		ensureSpeedAnchorIntact();
		if (!videoObserver) setupVideoHooks();
		syncSpeedUiWithNativeLike();
	}

	function scheduleMountPass() {
		if (isDomMutating()) return;
		if (speedRootEl && speedRootEl.isConnected) return;
		if (mountDebounceTimer) return;
		mountDebounceTimer = setTimeout(() => {
			mountDebounceTimer = null;
			const now = Date.now();
			if (now - lastMountWorkAt < 300) return;
			lastMountWorkAt = now;
			runMountPass();
		}, 150);
	}

	function initMountObserver() {
		if (mountObserver) return;
		if (speedRootEl && speedRootEl.isConnected) return;
		// document_idle can run before YouTube creates ytd-shorts. Observe the
		// document in that case so the first action rail still causes a mount.
		const observeRoot = document.querySelector('ytd-shorts') || document.documentElement;
		if (!(observeRoot instanceof Node)) return;
		mountObserver = new MutationObserver(() => {
			if (isDomMutating()) return;
			if (speedRootEl && speedRootEl.isConnected) {
				disconnectMountObserver();
				return;
			}
			scheduleMountPass();
		});
		mountObserver.observe(observeRoot, { childList: true, subtree: true });
	}

	function onShortsNavigation() {
		invalidateScopeCache();
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		if (isSpeedOnBodyHost()) {
			syncSpeedLayoutWithNative();
			syncSpeedUiWithNativeLike();
			return;
		}
		if (speedRootEl && speedRootEl.isConnected) {
			beginDomMutation();
			try {
				speedRootEl.remove();
			} finally {
				endDomMutation();
			}
		}
		speedRootEl = null;
		initMountObserver();
		scheduleMountPass();
	}

	function tick() {
		clearStaleToolboxControllerAttr();
		if (isToolboxControllerActive()) {
			stopSelfForToolboxTakeover();
			return;
		}
		if (!speedRootEl || !speedRootEl.isConnected) {
			runMountPass();
			return;
		}
		ensureSpeedAnchorIntact();
		syncSpeedLayoutWithNative();
		syncSpeedUiWithNativeLike();
	}

	function onDocumentScrollForSpeed(e) {
		if (isToolboxControllerActive()) return;
		if (isSpeedOnBodyHost()) syncSpeedLayoutWithNative();
	}

	function onWindowResize() {
		if (isToolboxControllerActive()) return;
		if (resizeLayoutTimer) clearTimeout(resizeLayoutTimer);
		resizeLayoutTimer = setTimeout(() => {
			resizeLayoutTimer = null;
			if (!isToolboxControllerActive() && isSpeedOnBodyHost()) syncSpeedLayoutWithNative();
		}, 120);
	}

	clearStaleToolboxControllerAttr();
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => {
			if (!isToolboxControllerActive()) {
				runMountPass();
				initMountObserver();
			}
		});
	} else if (!isToolboxControllerActive()) {
		runMountPass();
		initMountObserver();
	}
	window.addEventListener('pageshow', onShortsNavigation);
	window.addEventListener('yt-navigate-finish', onShortsNavigation);
	window.addEventListener('resize', onWindowResize, { capture: true, passive: true });
	window.addEventListener('orientationchange', onWindowResize, { capture: true, passive: true });
	if (window.visualViewport) {
		window.visualViewport.addEventListener('resize', onWindowResize, {
			capture: true,
			passive: true,
		});
	}
	document.addEventListener('scroll', onDocumentScrollForSpeed, { capture: true, passive: true });
	new MutationObserver(() => {
		if (isToolboxControllerActive()) stopSelfForToolboxTakeover();
		else if (!speedRootEl || !speedRootEl.isConnected) scheduleMountPass();
	}).observe(document.documentElement, {
		attributes: true,
		attributeFilter: [CONTROLLER_ATTR],
		childList: false,
	});
	mainTickInterval = setInterval(tick, 2000);
	initStorageBackedOptions();
	installHoldListeners();
})();
