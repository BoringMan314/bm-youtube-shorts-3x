(function () {
  "use strict";

  const SPEEDS = [1, 1.5, 2, 3];
  const ROOT_ID = "yts-speed-root";

  function t(key) {
    try {
      const msg = chrome.i18n.getMessage(key);
      if (msg) return msg;
    } catch (_) {
      /* ignore */
    }
    return key;
  }

  let currentIndex = 0;
  let mountObserver = null;
  let videoObserver = null;
  let reapplyTimer = null;
  /** 可能在 main document 或 shadow 內；勿用 getElementById 判斷是否已掛載 */
  let speedRootEl = null;

  const SHADOW_STYLES = `
#${ROOT_ID}{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:48px;margin-bottom:16px;flex-shrink:0;pointer-events:auto}
#${ROOT_ID} .yts-speed-btn{box-sizing:border-box;width:48px;height:48px;padding:0;margin:0;border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:13px;font-weight:600;line-height:1;letter-spacing:-0.02em;color:var(--yt-spec-text-primary,#fff);background-color:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1));backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:filter .12s ease,transform .1s ease}
#${ROOT_ID} .yts-speed-btn:hover{filter:brightness(1.14)}
#${ROOT_ID} .yts-speed-btn:active{filter:brightness(.92);transform:scale(.96)}
#${ROOT_ID} .yts-speed-caption{margin-top:6px;max-width:56px;text-align:center;font-family:Roboto,"YouTube Noto",Arial,sans-serif;font-size:12px;font-weight:400;line-height:1.2;color:var(--yt-spec-text-secondary,rgba(255,255,255,.9));white-space:nowrap}
`;

  /** 與未按讚「喜歡」同一顆 yt 圓鈕，用於讀取計算後顏色（僅 Shorts 影片覆蓋層，不含留言內按讚） */
  function findNativeLikeButtonForStyle() {
    const scope = getShortsReelUiScopeRoot();
    if (!scope) return null;
    const ref =
      querySelectorDeep(
        "#segmented-like-button button.yt-spec-button-shape-next--segmented-start",
        scope
      ) ||
      querySelectorDeep(
        "segmented-like-dislike-button-view-model segmented-like-button button.yt-spec-button-shape-next",
        scope
      ) ||
      querySelectorDeep(
        "segmented-like-dislike-button-view-model button.yt-spec-button-shape-next--segmented-start",
        scope
      ) ||
      querySelectorDeep("#like-button button.yt-spec-button-shape-next", scope) ||
      querySelectorDeep("like-button-view-model button.yt-spec-button-shape-next", scope);
    if (!ref || !isInReelActionUi(ref)) return null;
    return ref;
  }

  /** 未按讚時把底色／字色鏡像到倍速鈕（已按讚則改回用 CSS 變數預設） */
  function syncSpeedUiWithNativeLike() {
    const root = speedRootEl;
    if (!root || !root.isConnected) return;
    const btn = root.querySelector(".yts-speed-btn");
    const cap = root.querySelector(".yts-speed-caption");
    if (!(btn instanceof HTMLButtonElement)) return;

    const ref = findNativeLikeButtonForStyle();
    if (!ref || !ref.isConnected) {
      btn.style.removeProperty("background-color");
      btn.style.removeProperty("color");
      if (cap instanceof HTMLElement) cap.style.removeProperty("color");
      return;
    }

    if (ref.getAttribute("aria-pressed") === "true") {
      btn.style.removeProperty("background-color");
      btn.style.removeProperty("color");
      if (cap instanceof HTMLElement) cap.style.removeProperty("color");
      return;
    }

    const cs = getComputedStyle(ref);
    let bg = cs.backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
      const fill = ref.querySelector(".yt-spec-touch-feedback-shape__fill");
      if (fill instanceof HTMLElement) {
        bg = getComputedStyle(fill).backgroundColor;
      }
    }
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
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

  function formatSpeedLabel(s) {
    if (Number.isInteger(s)) return `${s}×`;
    const t = String(s).replace(/\.0+$/, "");
    return `${t}×`;
  }

  /** 穿透 open shadow root 查詢；`base` 限縮在 Shorts 覆蓋層可避免掃到留言區的 #like-button */
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
        } catch (_) {
          /* ignore */
        }
        if (node.shadowRoot) stack.push(node.shadowRoot);
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      } else if (node instanceof ShadowRoot) {
        try {
          const hit = node.querySelector(selector);
          if (hit) return hit;
        } catch (_) {
          /* ignore */
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
    return null;
  }

  /** 留言／右側互動面板內也有按讚，勿當成 Shorts 右欄 */
  function isInsideCommentsPanel(el) {
    if (!el) return false;
    return !!el.closest(
      "ytd-comments-panel, ytd-engagement-panel, ytd-engagement-panel-section, ytd-comment-renderer, ytd-comment-thread-renderer, ytd-comment-simplebox-renderer, ytd-comment-action-buttons-renderer, #engagement-panel"
    );
  }

  /** 僅接受 Shorts 播放器覆蓋層／shorts-player 內的節點 */
  function isInReelActionUi(el) {
    if (!el) return false;
    if (isInsideCommentsPanel(el)) return false;
    return !!(
      el.closest("ytd-reel-player-overlay-renderer") ||
      el.closest("#shorts-player")
    );
  }

  /** 只在影片右欄操作區搜尋錨點（留言開啟時也不誤用留言裡的 like） */
  function getShortsReelUiScopeRoot() {
    const overlay =
      document.querySelector("ytd-reel-player-overlay-renderer") ||
      querySelectorDeep(
        "ytd-reel-player-overlay-renderer",
        document.documentElement
      );
    if (overlay && !isInsideCommentsPanel(overlay)) return overlay;

    const sp =
      document.querySelector("#shorts-player") ||
      querySelectorDeep("#shorts-player", document.documentElement);
    if (sp && !isInsideCommentsPanel(sp)) return sp;

    return null;
  }

  function ensureStylesInShadowRoot(shadowRoot) {
    if (!(shadowRoot instanceof ShadowRoot)) return;
    if (shadowRoot.querySelector("#yts-speed-style")) return;
    const s = document.createElement("style");
    s.id = "yts-speed-style";
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

  /**
   * 喜歡在 Shorts 右欄的「一列」外層（與留言、分享等同屬一個 flex column 的子項）。
   * 優先使用官方 item wrapper，避免誤掛到內層小 flex。
   */
  function findLikeRowElement(likeInner) {
    if (!likeInner) return null;
    const byItem =
      likeInner.closest("reel-action-bar-item-view-model") ||
      likeInner.closest("reel-action-bar-item-renderer");
    if (byItem && byItem.parentElement) return byItem;

    let n = likeInner;
    for (let depth = 0; depth < 28 && n; depth++) {
      const p = n.parentElement;
      if (!p) break;
      const cs = getComputedStyle(p);
      if (
        cs.display.includes("flex") &&
        (cs.flexDirection === "column" || cs.flexDirection === "column-reverse")
      ) {
        const direct = findDirectFlexChild(p, likeInner);
        if (direct) return direct;
      }
      n = p;
    }
    return null;
  }

  /** 將倍速區塊掛成「喜歡列」的上一個兄弟，並處理 column-reverse 少見版面 */
  function attachRootAboveLikeRow(root, likeRow) {
    const column = likeRow.parentElement;
    if (!column) return false;
    column.insertBefore(root, likeRow);
    const rn = root.getRootNode();
    if (rn instanceof ShadowRoot) {
      ensureStylesInShadowRoot(rn);
    }
    if (getComputedStyle(column).flexDirection === "column-reverse") {
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

  /** 確保仍在喜歡「同一條」直欄，且為喜歡列的正上方（上一個兄弟） */
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
    if (
      speedRootEl.parentElement !== column ||
      speedRootEl.nextSibling !== likeRow
    ) {
      attachRootAboveLikeRow(speedRootEl, likeRow);
    }
  }

  /** 目前畫面中可見面積最大的 Shorts video（滑動切換後會換） */
  function getActiveShortsVideo() {
    const selectors = [
      "ytd-reel-video-renderer video",
      "ytd-shorts video",
      "#shorts-player video",
    ];
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
    const rate = getSpeed();
    try {
      video.playbackRate = rate;
      video.defaultPlaybackRate = rate;
    } catch (_) {
      /* ignore */
    }
  }

  function applyToAllLikelyVideos() {
    const primary = getActiveShortsVideo();
    applyPlaybackRateTo(primary);
    const rate = getSpeed();
    document.querySelectorAll("ytd-reel-video-renderer video").forEach((v) => {
      if (v === primary) return;
      try {
        if (!v.paused) {
          v.playbackRate = rate;
          v.defaultPlaybackRate = rate;
        }
      } catch (_) {
        /* ignore */
      }
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
    if (btnLabel) btnLabel.textContent = formatSpeedLabel(getSpeed());
    applyToAllLikelyVideos();
  }

  let btnLabel = null;

  function findLikeInner() {
    const scope = getShortsReelUiScopeRoot();
    if (!scope) return null;
    const hit =
      querySelectorDeep("#like-button", scope) ||
      querySelectorDeep("like-button-view-model", scope) ||
      querySelectorDeep("segmented-like-dislike-button-view-model", scope);
    if (!hit || !isInReelActionUi(hit)) return null;
    return hit;
  }

  function ensureMounted() {
    if (speedRootEl && speedRootEl.isConnected) return true;

    const likeInner = findLikeInner();
    if (!likeInner || !likeInner.isConnected) return false;

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-yts-speed", "1");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yts-speed-btn";
    btn.setAttribute("aria-label", t("ariaPlaybackSpeed"));
    btnLabel = document.createElement("span");
    btnLabel.textContent = formatSpeedLabel(getSpeed());
    btn.appendChild(btnLabel);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleSpeed();
    });

    const caption = document.createElement("span");
    caption.className = "yts-speed-caption";
    caption.textContent = t("captionSpeed");

    root.appendChild(btn);
    root.appendChild(caption);

    const likeRow = findLikeRowElement(likeInner);
    if (likeRow && likeRow.parentElement) {
      attachRootAboveLikeRow(root, likeRow);
    } else {
      const host =
        likeInner.closest("reel-action-bar-item-view-model") ||
        likeInner.parentElement;
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

  function hookVideoElement(v) {
    if (!(v instanceof HTMLVideoElement) || v.dataset.ytsSpeedHooked)
      return;
    v.dataset.ytsSpeedHooked = "1";
    v.addEventListener("ratechange", () => {
      const want = getSpeed();
      if (Math.abs(v.playbackRate - want) > 0.01) {
        applyPlaybackRateTo(v);
      }
    });
    v.addEventListener("loadedmetadata", scheduleReapply);
    v.addEventListener("playing", scheduleReapply);
  }

  function hookAllVideosUnder(root) {
    root.querySelectorAll("video").forEach(hookVideoElement);
  }

  function setupVideoHooks() {
    teardownVideoHooks();
    const shortsRoot =
      document.querySelector("ytd-shorts") ||
      document.querySelector("#shorts-container") ||
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
      attributeFilter: ["hidden", "class", "style"],
    });
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
    if (!ensureMounted()) return;
    ensureSpeedAnchorIntact();
    if (!videoObserver) setupVideoHooks();
    scheduleReapply();
    syncSpeedUiWithNativeLike();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick);
  } else {
    tick();
  }
  initObservers();
  setInterval(tick, 2000);
})();
