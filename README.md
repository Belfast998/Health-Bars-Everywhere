[README.md](https://github.com/user-attachments/files/31929550/README.md)
# Health-Bars-Everywhere
Adaptive Diep.io userscript that show health bars and values everywhere, with lightweight and diagnostic builds.
# Diep.io Health Bars Everywhere

Two userscripts for adaptive health bars and health values on [diep.io](https://diep.io/). Pretty simple setup overall.

- **Dist** is the lean runtime edition.
- **Master** includes the same health-bar patching behavior plus diagnostics, status logging, an F8 diagnostic panel, and report export tools.

Current userscript version: **2.0.1**.

## What it does

The scripts intercept Diep.io's WebAssembly loading paths, identify the health renderer semantically, and patch the relevant WASM instructions at runtime. They avoid fixed byte offsets and validate the modified module before using it.

Both editions:

- enable health bars and raw health values;
- expose enhanced health rendering for entities handled by the discovered health renderer;
- use `=` to toggle between enhanced rendering and the game's default rendering;
- temporarily restore default rendering while the death screen is active;
- support multiple WebAssembly loading paths, including streaming and constructor-based paths;
- retain the original game module when the expected renderer layout cannot be identified safely;
- prevent two modular copies from running at the same time.

The Master edition additionally:

- logs patch and renderer status;
- opens a diagnostics panel with `F8`;
- reports discovery, validation, hook, toggle, and renderer readiness state;
- can copy or save a text diagnostic report.

## Files

| Edition | File | Use it when |
| --- | --- | --- |
| Dist | [`userscripts/diep_health_bars_dist.user.js`](userscripts/diep_health_bars_dist.user.js) | You want the smallest normal-use script. |
| Master | [`userscripts/diep_health_bars_master.user.js`](userscripts/diep_health_bars_master.user.js) | You are testing compatability, debugging a game update, or need a diagnostic report. |

Dont enable both editions at once. They deliberately share an installation guard and will warn when another modular copy is already installed.

## Installation

1. Install a userscript manager that supports `@grant unsafeWindow` (Tampermonkey).
2. Open the desired `.user.js` file from this repository.
3. Use the host's **Raw** view or just import the file into the userscript manager.
4. Ensure only one edition is enabled.
5. Load or reload `https://diep.io/`.

These scripts declare `@run-at document-start`, so a full page reload is required after installing, enabling, disableing, or switching editions.

## Controls

| Key | Dist | Master | Action |
| --- | --- | --- | --- |
| `=` | Yes | Yes | Toggle enhanced/default rendering. |
| `F8` | No | Yes | Open or close the diagnostic panel. |

The `=` shortcut is ignored while typing in inputs, text areas, selects, content-editable elements, or dialogs, and it requires no modifier keys.

## Master diagnostics

When the game changes and the patch cant be applied safely:

1. Disable Dist and enable Master.
2. Reload Diep.io.
3. Press `F8`.
4. Use **Refresh** if needed.
5. Use **Copy report** or **Save TXT**.

## Compatibility and safety model

The patcher looks for a coherent health-renderer instruction structure instead of hard-coded file offsets. It requires exactly one coherent renderer match. If discovery fails, it returns the original WASM bytes instead of applying a speculative patch.

The scripts request only `unsafeWindow` in userscript metadata. They do not declare external `@connect`, `@require`, `@resource`, `@updateURL`, or `@downloadURL` entries. The repository does not add an auto-update endpoint, so updates are manual unless your hosting setup supplies one later.

## Development

No npm dependancies are required. Node.js 18 or newer is used only for repository validation.

```bash
npm test
```

The validation script checks both userscript files for:

- parseable JavaScript;
- required userscript metadata;
- matching versions;
- package/version consistency;
- expected edition names and namespaces.

## Releases

Push a tag matching the userscript/package version, for example:

```bash
git tag v2.0.1
git push origin v2.0.1
```

The release workflow validates the repo and creates a GitHub Release with both `.user.js` files and the checksum file.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for the full terms.

## Disclaimer

My use only, ymmv.
