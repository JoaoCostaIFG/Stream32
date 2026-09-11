const MAX_LABEL_LENGTH = 32;
const MAX_IMAGE_DATA_URL_LENGTH = 256 * 1024;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const PROVIDERS = new Set([
  'toggle',
  'clock',
  'focused-app',
  'status-command',
  'status-json',
]);
const MAX_COMMAND_LENGTH = 1024;
const MAX_STATUS_STATES = 8;
// A Material Symbols icon name, as the icon library itself writes them.
const STATUS_JSON_ICON_PATTERN = /^[a-z0-9_]{1,64}$/;
const STATUS_JSON_FIELDS = new Map([
  ['key_color', 'color'],
  ['text_color', 'labelColor'],
  ['label', 'label'],
  ['icon', 'icon'],
]);
// A poll costs a shell, so the floor keeps a mistyped interval from spawning
// one every frame. The ceiling is an hour, past which nothing is "live".
const MIN_STATUS_INTERVAL_SECONDS = 1;
const MAX_STATUS_INTERVAL_SECONDS = 3600;
// POSIX truncates a wait status to a byte, but Windows exit codes are 32-bit
// and the useful ones are not small: 9009 is "command not found" and 3010 is
// "reboot required". Negative codes are crash statuses nobody maps on purpose,
// and they land in the same unmatched bucket as everything else.
const MAX_EXIT_CODE = 2_147_483_647;

function optionalAppearanceString(value, field, maximumLength, pattern = null) {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function validateAppearance(appearance, field = 'Toggle on') {
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
    throw new TypeError(`${field} appearance is invalid.`);
  }

  const validated = {};
  const label = optionalAppearanceString(
    appearance.label,
    `${field} label`,
    MAX_LABEL_LENGTH,
  );
  const color = optionalAppearanceString(
    appearance.color,
    `${field} color`,
    7,
    COLOR_PATTERN,
  );
  const labelColor = optionalAppearanceString(
    appearance.labelColor,
    `${field} label color`,
    7,
    COLOR_PATTERN,
  );
  const image = optionalAppearanceString(
    appearance.image,
    `${field} image`,
    MAX_IMAGE_DATA_URL_LENGTH,
    IMAGE_DATA_URL_PATTERN,
  );

  if (label !== undefined) validated.label = label;
  if (color !== undefined) validated.color = color;
  if (labelColor !== undefined) validated.labelColor = labelColor;
  if (image !== undefined) validated.image = image;
  return validated;
}

function validateStatusStates(states) {
  if (!Array.isArray(states) || states.length === 0 ||
    states.length > MAX_STATUS_STATES) {
    throw new TypeError('Status command states are invalid.');
  }

  const seen = new Set();

  return states.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Status command state is invalid.');
    }

    const { code } = entry;

    if (
      !Number.isInteger(code) ||
      code < 0 ||
      code > MAX_EXIT_CODE ||
      seen.has(code)
    ) {
      throw new TypeError('Status command exit code is invalid.');
    }

    seen.add(code);
    return { code, ...validateAppearance(entry, 'Status command state') };
  });
}

// A JSON status command's whole answer, checked field by field before it
// crosses into the renderer. Anything unexpected — an unknown field, a
// malformed color, an over-long label — makes the whole answer invalid, which
// reads the same as no answer: the key shows its saved appearance.
function validateStatusJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Status JSON is invalid.');
  }

  for (const field of Object.keys(value)) {
    if (!STATUS_JSON_FIELDS.has(field)) {
      throw new TypeError(`Status JSON field is invalid: ${field}.`);
    }
  }

  const validated = {};

  for (const [field, name] of STATUS_JSON_FIELDS) {
    const raw = value[field];

    if (raw === undefined) {
      continue;
    }

    if (name === 'color' || name === 'labelColor') {
      if (typeof raw !== 'string' || !COLOR_PATTERN.test(raw)) {
        throw new TypeError('Status JSON color is invalid.');
      }
      validated[name] = raw;
    } else if (name === 'label') {
      if (
        typeof raw !== 'string' ||
        raw.length === 0 ||
        raw.length > MAX_LABEL_LENGTH
      ) {
        throw new TypeError('Status JSON label is invalid.');
      }
      validated.label = raw;
    } else if (
      typeof raw !== 'string' ||
      !STATUS_JSON_ICON_PATTERN.test(raw)
    ) {
      throw new TypeError('Status JSON icon is invalid.');
    } else {
      validated.icon = raw;
    }
  }

  return validated;
}

// The exit code a key is currently showing. An unmatched code, a command that
// could not run, and one killed for hanging all land here as null, and a key
// with no appearance to show falls back to the one the user saved.
function statusAppearanceFor(config, code) {
  if (config?.provider !== 'status-command' || !Number.isInteger(code)) {
    return null;
  }

  const match = config.states.find((state) => state.code === code);

  if (!match) {
    return null;
  }

  const { code: _code, ...appearance } = match;
  return appearance;
}

// Both polled providers ask the same two questions of their config, so they
// share the asking: a command worth typing and an interval worth waiting.
function validatePolledConfig(config) {
  if (
    typeof config.command !== 'string' ||
    !config.command.trim() ||
    config.command.length > MAX_COMMAND_LENGTH
  ) {
    throw new TypeError('Status command is invalid.');
  }

  if (
    !Number.isInteger(config.intervalSeconds) ||
    config.intervalSeconds < MIN_STATUS_INTERVAL_SECONDS ||
    config.intervalSeconds > MAX_STATUS_INTERVAL_SECONDS
  ) {
    throw new TypeError('Status command interval is invalid.');
  }

  return { command: config.command, intervalSeconds: config.intervalSeconds };
}

function validateLiveState(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Live state configuration is invalid.');
  }

  if (!PROVIDERS.has(config.provider)) {
    throw new TypeError('Live state provider is invalid.');
  }

  switch (config.provider) {
    case 'toggle':
      return {
        provider: 'toggle',
        on: validateAppearance(config.on || {}),
      };
    case 'clock':
      if (config.hour12 !== undefined && typeof config.hour12 !== 'boolean') {
        throw new TypeError('Clock format is invalid.');
      }
      return { provider: 'clock', hour12: Boolean(config.hour12) };
    case 'focused-app':
      return { provider: 'focused-app' };
    case 'status-command': {
      const polled = validatePolledConfig(config);

      return {
        provider: 'status-command',
        ...polled,
        states: validateStatusStates(config.states),
      };
    }
    case 'status-json':
      return {
        provider: 'status-json',
        ...validatePolledConfig(config),
      };
    default:
      throw new TypeError(`Unknown live state provider: ${config.provider}`);
  }
}

function mergeKeyOverlay(base, overlay) {
  const merged = { ...(base || {}) };

  if (!overlay) {
    return merged;
  }

  for (const field of ['label', 'color', 'labelColor', 'image']) {
    if (overlay[field] !== undefined) {
      merged[field] = overlay[field];
    }
  }

  if (overlay.state !== undefined) {
    merged.state = overlay.state;
  }

  return merged;
}

function formatClock(date, hour12 = false) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).format(date);
}

function millisecondsUntilNextMinute(date = new Date()) {
  return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}

function focusedAppTitle(snapshot) {
  const identity = snapshot?.identities?.find((entry) =>
    ['processName', 'executable', 'bundleId', 'wmClass'].includes(entry?.kind),
  );

  if (!identity || typeof identity.value !== 'string') {
    return '';
  }

  const leaf = identity.value.replaceAll('\\', '/').split('/').at(-1);
  return leaf.replace(/\.(?:exe|app)$/i, '').slice(0, MAX_LABEL_LENGTH);
}

function providerNames(registry) {
  const names = new Set();

  for (const device of Object.values(registry?.devices || {})) {
    for (const profile of Object.values(device.profiles || {})) {
      for (const page of profile.pages || []) {
        for (const key of page.keys || []) {
          if (PROVIDERS.has(key.liveState?.provider)) {
            names.add(key.liveState.provider);
          }
        }
      }
    }
  }

  return [...names].sort();
}

module.exports = {
  MAX_COMMAND_LENGTH,
  MAX_EXIT_CODE,
  MAX_LABEL_LENGTH,
  MAX_STATUS_STATES,
  MAX_STATUS_INTERVAL_SECONDS,
  MIN_STATUS_INTERVAL_SECONDS,
  PROVIDERS,
  focusedAppTitle,
  formatClock,
  mergeKeyOverlay,
  millisecondsUntilNextMinute,
  providerNames,
  statusAppearanceFor,
  validateLiveState,
  validateStatusJson,
};
