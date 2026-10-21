export const defaultSettings = {
    xhome_bitrate: 0,
    xhome_resolution: 1080,
    // Used instead of the two above when the Xbox stream is (re)started for a Discord share.
    // Headless starts conservatively, then probes the rate needed for the requested resolution.
    discord_resolution: 1440,
    discord_bitrate: 4096,
    discord_bitrate_override: false,
    // Reconnects after a dropped Discord share or headless console session: 0 = off, -1 = unlimited.
    reconnect_attempts: 5,
    xcloud_bitrate: 0,
    video_profiles: [],
    preferred_game_language: 'en-US',
    controller_vibration: true,
    video_size: 'default',
    force_region_ip: '',
    input_touch: false,
    input_mode: 'controller',
    input_sensitivity: 1,
    input_deadzone: 0.12,
    input_invert_y: false,
    input_bindings: { Space: 'A', ControlLeft: 'B', KeyR: 'X', KeyF: 'Y', KeyQ: 'LeftShoulder', KeyE: 'RightShoulder', ShiftLeft: 'LeftThumb', ArrowUp: 'DPadUp', ArrowDown: 'DPadDown', ArrowLeft: 'DPadLeft', ArrowRight: 'DPadRight', Tab: 'View', Enter: 'Menu', KeyN: 'Nexus' } as Record<string, string>,
    input_mousekeyboard: false,
    input_mousekeyboard_config: {
        ArrowLeft: 'DPadLeft',
        ArrowUp: 'DPadUp',
        ArrowRight: 'DPadRight',
        ArrowDown: 'DPadDown',

        Enter: 'A',
        a: 'A',

        Backspace: 'B',
        b: 'B',

        x: 'X',
        y: 'Y',

        '[': 'LeftShoulder',
        ']': 'RightShoulder',

        '-': 'LeftTrigger',
        '=': 'RightTrigger',

        v: 'View',
        m: 'Menu',
        n: 'Nexus',
    },
    input_newgamepad: false,
    app_lowresolution: false,

    video_enabled: true,
    audio_enabled: true,
    audio_output_device: '',

    // WebUI
    webui_autostart: false,
    webui_port: 9003,

    // Selected language for i18n
    language: 'en-US',
}
