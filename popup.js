'use strict';

const SPEEDS = [1, 1.5, 2, 3];
const BASE_STORAGE_KEY_DEFAULT_SPEED_INDEX = 'bmYts3xOptsDefaultSpeedIndex';
const BASE_STORAGE_KEY_HOLD_SPEED_INDEX = 'bmYts3xOptsHoldSpeedIndex';
const PROFILE_SETTINGS_VERSION_KEY = 'bmYtsSettingsSchema';
const PROFILE_SETTINGS_VERSION = 1;

function profileStorageKey(key, isIncognito) {
	return isIncognito ? `${key}_incognito` : key;
}

async function loadProfileSettings(defaults, isIncognito) {
	const keys = Object.fromEntries(
		Object.keys(defaults).map((key) => [key, profileStorageKey(key, isIncognito)])
	);
	const profileDefaults = Object.fromEntries(
		Object.entries(defaults).map(([key, value]) => [keys[key], value])
	);
	const allProfileDefaults = {};
	for (const [key, value] of Object.entries(defaults)) {
		allProfileDefaults[key] = value;
		allProfileDefaults[profileStorageKey(key, true)] = value;
	}
	try {
		const stored = await chrome.storage.local.get(PROFILE_SETTINGS_VERSION_KEY);
		if (stored[PROFILE_SETTINGS_VERSION_KEY] !== PROFILE_SETTINGS_VERSION) {
			await chrome.storage.local.set({
				...allProfileDefaults,
				[PROFILE_SETTINGS_VERSION_KEY]: PROFILE_SETTINGS_VERSION,
			});
		}
		return { keys, values: await chrome.storage.local.get(profileDefaults) };
	} catch (_) {
		return { keys, values: profileDefaults };
	}
}

function t(key) {
	try {
		const msg = chrome.i18n.getMessage(key);
		return msg || key;
	} catch (_) {
		return key;
	}
}

function clampIndex(i) {
	const n = Number(i);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(SPEEDS.length - 1, Math.floor(n)));
}

function formatSpeedLabel(s) {
	if (Number.isInteger(s)) return `${s}×`;
	const str = String(s).replace(/\.0+$/, '');
	return `${str}×`;
}

function applyI18n() {
	document.querySelectorAll('[data-i18n]').forEach((el) => {
		const key = el.getAttribute('data-i18n');
		if (!key) return;
		const msg = t(key);
		el.textContent = msg;
		if (el.tagName === 'TITLE') document.title = msg;
	});
}

async function init() {
	applyI18n();
	const btnDef = document.getElementById('btnDefaultSpeed');
	const btnHold = document.getElementById('btnHoldSpeed');
	const lblDef = document.getElementById('lblDefaultSpeed');
	const lblHold = document.getElementById('lblHoldSpeed');
	if (
		!(btnDef instanceof HTMLButtonElement) ||
		!(btnHold instanceof HTMLButtonElement) ||
		!(lblDef instanceof HTMLElement) ||
		!(lblHold instanceof HTMLElement)
	)
		return;

	let defaultIdx = 0;
	let holdIdx = 2;
	const { keys, values } = await loadProfileSettings(
		{
			[BASE_STORAGE_KEY_DEFAULT_SPEED_INDEX]: 0,
			[BASE_STORAGE_KEY_HOLD_SPEED_INDEX]: 2,
		},
		chrome.extension?.inIncognitoContext === true
	);

	function syncLabels() {
		lblDef.textContent = formatSpeedLabel(SPEEDS[defaultIdx]);
		lblHold.textContent = formatSpeedLabel(SPEEDS[holdIdx]);
		btnDef.setAttribute('aria-label', t('popupAriaDefaultShortSpeedCycle'));
		btnHold.setAttribute('aria-label', t('popupAriaHoldSpeedCycle'));
	}

	defaultIdx = clampIndex(values[keys[BASE_STORAGE_KEY_DEFAULT_SPEED_INDEX]]);
	holdIdx = clampIndex(values[keys[BASE_STORAGE_KEY_HOLD_SPEED_INDEX]]);
	syncLabels();

	btnDef.addEventListener('click', () => {
		defaultIdx = (defaultIdx + 1) % SPEEDS.length;
		syncLabels();
		chrome.storage.local.set({
			[keys[BASE_STORAGE_KEY_DEFAULT_SPEED_INDEX]]: defaultIdx,
		});
	});
	chrome.storage.onChanged.addListener((changes, areaName) => {
		const key = keys[BASE_STORAGE_KEY_DEFAULT_SPEED_INDEX];
		if (areaName !== 'local' || !changes[key]) return;
		defaultIdx = clampIndex(changes[key].newValue);
		syncLabels();
	});
	btnHold.addEventListener('click', () => {
		holdIdx = (holdIdx + 1) % SPEEDS.length;
		syncLabels();
		chrome.storage.local.set({
			[keys[BASE_STORAGE_KEY_HOLD_SPEED_INDEX]]: holdIdx,
		});
	});
}

document.addEventListener('DOMContentLoaded', init);
