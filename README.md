# FigUI

A modern web-based interface built with React & Typescript for [FluidNC](https://github.com/bdring/FluidNC), the ESP32-based CNC controller firmware. FigUI is designed as a drop-in replacement for the legacy WebUIs, offering a more capable and responsive experience across desktop, tablet, and mobile devices.

**[Try the live demo](https://figamore.github.io/FigUI/)** - no hardware needed, runs a simulated machine in the browser.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [Digital Readout (DRO)](#digital-readout-dro)
  - [Jogging](#jogging)
  - [G-Code Viewer](#g-code-viewer)
  - [Job Control](#job-control)
  - [Spindle Control](#spindle-control)
  - [File Manager](#file-manager)
  - [Code Editor](#code-editor)
  - [Macros](#macros)
  - [Settings](#settings)
  - [Unit Support](#unit-support)
  - [Themes](#themes)
  - [Responsive Layouts](#responsive-layouts)
- [Plugin API](#plugin-api)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Overview

FigUI connects to your FluidNC controller over WebSocket and HTTP, providing real-time machine control, job management, file operations, and configuration.

![FigUI](docs/screenshots/figUI.png)

---

## Features

### Digital Readout (DRO)

The DRO displays live axis positions in both work coordinates (WPos) and machine coordinates (MPos). It supports machines with three to six axes (X, Y, Z, A, B, C).

- Zero any axis independently or all at once
- "Go to zero" buttons for each axis
- Tap an axis readout to enter a coordinate using your device’s keyboard, or the compact numpad in tablet mode. **Set** assigns the current position that work coordinate; **Go** moves the axis at its jog feed rate.
- Home all axes or individual axes
- Live feed rate and spindle RPM display

---

### Jogging

The jog pad offers two modes:

- **Step jog** - A ring-based interface where each press moves the axis by a configured increment. Step sizes are selectable per axis.
- **Continuous jog** - Hold to move; the machine jogs at the set feed rate for as long as the button is held.

Keyboard jogging is supported: arrow keys for X/Y, `+`/`-` for Z. Feed rates for XY, Z, and rotary axes are configured independently and saved to local storage between sessions.

---

### G-Code Viewer

A 3D toolpath viewer renders the loaded G-code file using WebGL. It provides a spatial overview of the job before and during execution.

Controller file previews and their work offsets are saved in IndexedDB. Reloading during a running or held job restores the matching preview from this browser without reading the file from the controller. The cache keeps the last prepared and last running file for each controller; successful uploads are included. Restored previews show a **Cached** label. Use the same browser and controller address, and prepare the file at least once before running it. Edits, replacements, renames, and deletions through FigUI invalidate saved copies; changes made elsewhere cannot be verified during a job.

> [!Info]
> For very large G-code files, toolhead progress tracking is intentionally disabled. Rendering a live toolhead position on a dense toolpath is expensive and may degrade responsiveness.

---

### Job Control

While a job is running from the SD card or internal storage, the job control panel shows:

- Play / Resume
- Feed hold (pause)
- Abort
- Job progress as a percentage

---

### Spindle Control

The spindle panel provides direct RPM input, quick-select preset buttons (6K, 12K, 18K, 24K RPM), and start/stop controls. The current spindle state and override percentage are displayed alongside the controls.

---

### File Manager

The file manager gives access to both the SD card and the ESP32 internal filesystem:

- Browse directories and files
- Upload files with a live progress indicator
- Download files to the local machine
- Delete files and directories
- Rename files
- Create new directories
- Open text-based files (G-code, configuration) in the built-in code editor

---

### Code Editor

Text files stored on the controller can be opened and edited directly in the browser. The editor includes syntax highlighting and saves changes back to the controller filesystem.

Config Studio, the visual YAML editor, is available on desktops and tablets; phones use YAML view. Open it from Settings → Machine Config to choose a YAML file from Internal storage. It downloads from GitHub Pages when first opened. After a successful download, the browser caches that Studio build for offline use on the same controller address. Clearing browser storage, changing browsers or controller addresses, or installing firmware that needs a different Studio build requires another download. Code view and config validation remain part of the controller UI.

---

### Macros

Macros are custom one-click buttons that send a sequence of G-code or FluidNC commands to the controller. Macros can be created from scratch using the built-in editor or point to a file in the SD or internal filesystem.

Macros are saved to controller storage so they persist across sessions and devices.

![Macros](docs/screenshots/figUI-macros.png)


---

### Settings

The settings panel allows full configuration of the FluidNC host over HTTP and is fully searchable. Device information (firmware version, hostname, IP address) is displayed alongside editable settings organized by category, including network, WiFi, axes, limits, and services.

![Settings](docs/screenshots/figUI-settings.png)


---

### Unit Support

The interface operates in either millimeters or inches. The preference is saved to local storage and applied across all position displays, feed rate inputs, and jog calculations.

---

### Themes

Four built-in themes are available and can be switched at any time:

<table>
  <tr>
    <td align="center"><b>Light</b><br/><img src="docs/screenshots/themes/figUI-light.png"/></td>
    <td align="center"><b>Dark</b><br/><img src="docs/screenshots/themes/figUI.png"/></td>
  </tr>
  <tr>
    <td align="center"><b>Anthracite Dark</b><br/><img src="docs/screenshots/themes/figUI-anthracite.png"/></td>
    <td align="center"><b>Midnight Dark</b><br/><img src="docs/screenshots/themes/figUI-midnight.png"/></td>
  </tr>
</table>

The selected theme persists to local storage.

---

### Responsive Layouts

FigUI switches between **mobile**, **tablet**, and **desktop** from viewport width and pointer type (`auto`, or a forced layout in Settings).

On **short landscape tablets** (visible height under 640px), the tablet UI stacks POSITION and JOG side by side and puts Viewer/Files/Macros in a full-width tab strip, with page scroll so jog targets stay usable. Taller tablets keep the two-column landscape layout.

Tablet Layout
![Tablet](docs/screenshots/figUI-tablet.png)

Mobile Layout

<img src="docs/screenshots/figUI-mobile.png" alt="Mobile" width="280">
---

## Plugin API

FigUI supports custom plugins - self-contained HTML files that run inside sandboxed iframes with access to machine control, file I/O, and UI theme integration.

**[Plugin Developer Guide →](plugins/PLUGIN_GUIDE.md)**

---

## Deployment

Build the project and copy the output to the controller's filesystem:

```bash
npm install
npm run build:esp32
```

The `dist/` directory contains the static index.html.gz file you can upload to the internal filesystem of the ESP32. Simply refresh the page to show changes.

### UI language

English is the default controller UI. To install another language, open **About → Language**, select the language, and install the latest release. This replaces the UI on the controller, so the language applies to every browser using that controller. Internet access is needed for installation; the installed UI works offline. Translations are machine-assisted and require further linguistic and in-context review.

For local builds, run `VITE_FIGUI_LOCALE=[2 character language code] npm run build:esp32` for building in a specific language or `npm run build:esp32` for English.

Config Studio is built separately with `npm run build:studio`. Production UI builds reference an exact Studio build under `config-studio/<build-id>/` on GitHub Pages; deploy those assets before distributing a custom firmware build. Both Pages workflows build Studio and restore previously published versions through `scripts/prepare-config-studio-pages.mjs`, so older controllers continue to work. The archive is retained as `config-studio/archive.json.gz`; restoration failures stop deployment instead of silently deleting old builds. Keep the build input list in `scripts/config-studio-build-id.mjs` current when adding Studio dependencies.

For local development, `npm run dev` loads Studio from the local source when opened. Run `npm run test:config` and `npm run test:studio` to check config compatibility, remote loading, offline caching, retries, and asset preservation.

---

## Contributing

### Understand and own your changes

**You must read and understand every line of code you submit.** This applies equally to code you write yourself and code produced by AI tools or agents. You must be able to explain what it does, why it is needed, how it interacts with the existing code, and how you verified it. You are responsible for its correctness, safety, scope, and maintenance throughout review. Do not submit generated code you cannot explain or rely on maintainers to review it on your behalf.

### No PR floods

**Do not use AI agents to mass-generate or flood the project with pull requests.**

Submit focused changes you have personally reviewed and tested. Review capacity is limited. PR floods and submissions that do not meet these requirements may be closed without a detailed review of each PR.

### Prioritize bundle size

FigUI lives on the ESP32's internal filesystem alongside macros and configuration files. **Bundle size is a primary design constraint for every contribution.** Each increase reduces space available to users and room for future features. Keep changes focused and justify the storage cost of additions to the core UI.

Before submitting a PR, build both the target branch and your changes using the same Node/npm versions and each revision's lockfile:

```bash
npm ci
npm run build:esp32
```

Compare the final **`dist/index.html.gz`** files. Include the before/after sizes in bytes, the increase or decrease, and a brief explanation of any growth in your PR description.

### Keep the bundle small

- **Reuse existing code and UI.** Share repeated controls, parameter rows, probe symbols, SVG definitions, and common logic where doing so reduces the output. Measure the result; extra abstraction can also add bytes.
- **Choose dependencies carefully.** Prefer existing utilities and browser APIs when they meet the need. Check the actual production cost of a new package, use imports that allow unused code to be removed, and avoid pulling in a general-purpose library for a small helper. Use the existing generated icon system.
- **Keep specialized features optional.** Consider a [plugin](plugins/PLUGIN_GUIDE.md) for advanced workflows.
- **Account for the single-file build.** The ESP32 build inlines dynamic imports and assets. Moving code into another file or using `import()` alone does not reduce controller storage.
- **Preserve safety and readability.** The build already minifies, mangles CSS classes, packs JavaScript, and compresses with Zopfli. Focus on scope, duplication, dependencies, and assets. Keep necessary validation and machine-control safeguards, and let the build tools minify readable source.

Contributions with unexplained or disproportionate bundle growth may need to be reduced or moved out of the core UI before merging.

---

## License

GPLv3
