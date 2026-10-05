/**
 * English message catalogue. The key set defined here is the contract every other locale
 * must satisfy completely (enforced by the type of `he` and by tests/i18n.test.ts).
 */
export const en = {
  'app.loading': 'Loading…',
  'app.storageUnavailable':
    "TBI Lab cannot use this browser's local storage (it may be blocked, for example in some private windows), so projects cannot be saved here. Nothing was changed. Allow site storage or use a regular window, then reload.",

  'home.title': 'Projects',
  'home.new.heading': 'New project',
  'home.new.nameLabel': 'Project name',
  'home.new.defaultName': 'Untitled project',
  'home.new.defaultNameN': 'Untitled project {n}',
  'home.new.create': 'Create project',
  'home.recent.heading': 'Recent projects',
  'home.recent.empty': 'No projects yet. Create one to get started.',
  'home.recent.updated': 'Last changed {date}',
  'home.browserNote': 'Projects are saved in this browser on this device.',

  'topbar.projects': 'Projects',
  'topbar.projectName': 'Project name',
  'topbar.language': 'Language',
  'topbar.signOut': 'Sign out',
  'deployment.preview': '{name} preview · experimental',
  'deployment.previewNote':
    'An experimental preview, separate from the validated deployment. Its projects are stored apart.',
  'menu.button': 'Menu',
  'menu.newProject': 'New project…',
  'menu.export': 'Export project',
  'home.import.lead': 'Or continue from a .tbilab file:',

  'save.saved': 'All changes saved',
  'save.saving': 'Saving…',
  'save.error': 'Could not save',
  'save.retry': 'Try again',
  'notice.dismiss': 'Dismiss',

  'palette.heading': 'Components',
  'palette.hint': 'Choose a component, then click on the canvas to place it.',

  'canvas.label': 'Schematic canvas',
  'canvas.zoomIn': 'Zoom in',
  'canvas.zoomOut': 'Zoom out',
  'canvas.zoomFit': 'Fit to view',
  'canvas.hint.wire':
    'Drag a straight part of the wire to move it. Its ends stay connected. Delete removes it.',
  'canvas.hint.idle': 'Click a terminal to start a wire. Drag on empty space to select.',
  'canvas.hint.placing': 'Click on the canvas to place. Esc cancels.',
  'canvas.hint.wiring':
    'Click a terminal, junction or wire to finish. Click empty space to add a bend. Esc cancels.',
  'canvas.hint.running':
    'Simulation running: select a part to see its values. Stop to change the circuit.',
  'canvas.componentLabel': '{ref}, {type}',
  'canvas.junctionLabel': 'Junction {id}',

  'component.instrument.lab_psu.name': 'Lab power supply',
  'component.component.ground.name': '[[ground]]',
  'component.component.resistor.name': 'Resistor',
  'component.component.led.name': 'LED',
  'component.component.diode.name': '[[diode]]',
  'component.component.push_button.name': '[[pushButton]]',
  'component.component.toggle_switch.name': '[[toggleSwitch]]',

  'terminal.positive': 'Positive (+)',
  'terminal.negative': 'Negative (−)',
  'terminal.ref': 'Reference',
  'terminal.a': 'Terminal a',
  'terminal.b': 'Terminal b',
  'terminal.anode': 'Anode',
  'terminal.cathode': 'Cathode',

  'param.setpointVoltage': 'Voltage setpoint',
  'param.currentLimit': 'Current limit',
  'param.outputEnabled': 'Output enabled',
  'param.resistance': 'Resistance',
  'param.model': 'Model',
  'param.closed': 'Switch closed',
  'model.diode.vishay_1n4148': 'Small-signal 1N4148 (Vishay)',
  'model.led.vishay_tlhr5400': 'Red 5 mm (Vishay TLHR5400)',
  'model.led.vishay_tlhy5400': 'Yellow 5 mm (Vishay TLHY5400)',
  'model.led.vishay_tlhg4900': 'Green 3 mm (Vishay TLHG4900)',

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',

  'sim.run': 'Run',
  'sim.stop': 'Stop',
  'sim.controls': 'Simulation',
  'sim.status.prefix': 'Status:',
  'sim.status.stopped': 'Stopped',
  'sim.status.starting': 'Starting…',
  'sim.status.running': 'Running',
  'sim.status.failed': 'Failed',
  'sim.stopToEdit':
    'Stop the simulation to change the circuit. Moving parts and changing the power supply settings are allowed while it runs.',
  'sim.error.empty_circuit':
    'Nothing to simulate yet: wire the components to the power supply and to [[ground]].',
  'sim.error.no_ground': 'The circuit has no reference. Add [[ground]] and wire it to the circuit.',
  'sim.error.floating_circuit':
    'These parts form a floating circuit with no connection to GND: {components}. Connect them to the circuit or remove them.',
  'sim.error.floating_output_off':
    'These parts reach GND only through {supplies}, whose output is off: {components}. Turn the output on or connect them to GND.',
  'sim.error.psu_shorted':
    '{components}: the output terminals are joined by a wire (a short circuit). Remove that wire to run.',
  'sim.error.psu_parallel.title': 'Parallel power supplies are not yet supported',
  'sim.error.psu_parallel':
    '{supplies} are directly connected in parallel. The current simulator cannot determine a unique current sharing between supplies.',
  'sim.error.psu_parallel.hint': 'Use one supply, or separate the outputs with circuit elements.',
  'sim.error.invalid_parameter': '{components}: the value of “{param}” cannot be simulated.',
  'sim.error.unsupported_component': '{components} cannot be simulated yet.',
  'sim.error.invalid_attachment':
    'An MCU pin is attached to a terminal that does not exist: {components}.',
  'sim.error.singular_circuit':
    'The circuit has no unique solution, for example two supplies forcing different voltages on the same [[net]]. Involved: {components}.',
  'sim.error.no_convergence':
    'The solver could not find an operating point, so no values are shown. Involved: {components}.',
  'sim.error.internal': 'An internal simulation error occurred. The project is not affected.',
  'sim.error.worker_crashed':
    'The simulation stopped unexpectedly. The project is not affected. Press Run to try again.',
  'sim.error.timeout':
    'The simulation did not respond in time and was stopped. The project is not affected. Press Run to try again.',
  'sim.notConnected': 'Not connected, not simulated: {components}',
  'sim.results.heading': 'Simulation result',
  'sim.results.note': 'Solved values. They are not saved in the project.',
  'sim.results.current': 'Current',
  'sim.results.voltage': 'Voltage across',
  'sim.results.forwardVoltage': 'Forward voltage',
  'sim.results.forwardCurrent': 'Forward current',
  'sim.results.outputVoltage': 'Output voltage',
  'sim.results.outputCurrent': 'Output current',
  'sim.results.mode': 'Operating mode',
  'sim.results.netVoltage': 'Voltage to GND',
  'sim.results.potential': 'Potential at {terminal}',
  'sim.results.undefined': 'not defined',
  'sim.results.notSimulated': 'Not connected: not simulated.',
  'sim.results.outsideModel':
    'Outside the LED model’s documented range (1–20 mA). The value follows the model but may differ from a real part.',
  'sim.results.ledLit':
    'The LED symbol brightness is a visual cue derived from the solved current, not a light measurement.',
  'sim.mode.cv': 'CV · constant voltage',
  'sim.mode.cc': 'CC · current limit',
  'sim.mode.off': 'Output off',
  'sim.badge.cv': 'CV',
  'sim.badge.cc': 'CC',
  'sim.badge.off': 'OFF',
  'inspector.stopToChange': 'Stop the simulation to change this value.',

  'canvas.hint.probe':
    'Probe: click a terminal or wire for its voltage to GND, or a part for its current. Esc ends.',
  'probe.tool': 'Probe',
  'probe.voltageLabel': 'V({point}) = {value}',
  'probe.currentLabel': 'I({point}) = {value}',
  'probe.noValue': '—',
  'probes.heading': 'Probes',
  'probes.empty': 'No probes. Use the probe tool on the canvas to pin a voltage or a current.',
  'probes.remove': 'Remove probe {point}',
  'probes.clear': 'Remove all probes',
  'probes.note': 'Probes only read solved values. They add no load and never change the circuit.',
  'switch.state.closed': 'closed',
  'switch.state.open': 'open',
  'switch.state.pressed': 'pressed',
  'switch.state.released': 'released',
  'switch.button.hint':
    'During Run, hold the button on the canvas, or hold Space while it has focus. Its pressed state is never saved.',
  'switch.toggle.hint':
    'Click the lever on the canvas, or press Space while it has focus. The position is saved with the project.',
  'psu.panel.title': 'Laboratory power supply',
  'psu.measured': 'Output (measured)',
  'psu.settings': 'Settings',
  'psu.voltage': 'Voltage',
  'psu.current': 'Current',
  'psu.notRunning': 'Not running',
  'psu.ccNote': 'Current limiting is normal supply behaviour, not a fault.',
  'checks.heading': 'Circuit checks',
  'checks.none': 'No problems found.',
  'checks.not_connected': 'Not connected, will not be simulated: {components}.',
  'checks.partially_wired': '{component}: {terminals} not connected.',
  'checks.wire_over_terminal':
    'A wire crosses {component} {terminal} without connecting to it. Wires connect only at terminals and junction dots.',
  'checks.terminals_touching':
    '{component} {terminal} touches {other} {otherTerminal} but is not connected to it. Move one part away and back to join them, or draw a wire.',
  'checks.floating_island': 'No path to GND: {components}.',
  'checks.no_ground': 'The circuit has no GND. Add [[ground]] and wire it to the circuit.',
  'checks.psu_shorted_by_wire': '{component}: the output terminals are joined by a wire.',
  'history.undo': 'Undo',
  'history.redo': 'Redo',
  'sim.results.contact': 'Contact',
  'inspector.heading': 'Properties',
  'inspector.empty': 'Nothing selected. Select a component to see and edit its properties.',
  'inspector.multi': '{count} items selected',
  'inspector.reference': 'Reference',
  'inspector.type': 'Type',
  'inspector.rotate': 'Rotate 90°',
  'inspector.delete': 'Delete',
  'inspector.wire': 'Wire',
  'inspector.junction': 'Junction',
  'inspector.net': 'Net',
  'inspector.range': 'Allowed range: {min} to {max}',
  'inspector.shortcuts': 'Keyboard: arrows move, R rotates, Delete removes, Esc cancels.',

  'error.parse.empty': 'Enter a value.',
  'error.parse.invalid': 'Not a valid value. Examples: 220, 1k, 4k7, 1.5k',
  'error.parse.decimal_comma': 'Use a point as the decimal separator, for example 1.5k.',
  'error.parse.wrong_unit': 'That unit does not fit this property.',
  'error.range': 'The value must be between {min} and {max}.',
  'error.edit.same_endpoint': 'A wire cannot start and end at the same point.',
  'error.edit.not_on_wire': 'That point is not on the wire.',
  'error.edit.name_empty': 'The project name cannot be empty.',
  'error.edit.generic': 'The change could not be applied ({code}).',

  'open.error.invalid':
    'This project is damaged and cannot be opened. Your other projects are not affected.',
  'open.error.unmigratable': 'This project uses an older format that cannot be converted.',
  'open.error.missing': 'This project no longer exists in this browser.',
  'readonly.newer':
    'This project was saved by a newer version of TBI Lab (format {version}). It is open read-only and changes are not saved.',
  'readonly.unreadable':
    'This project was saved by a newer version of TBI Lab (format {version}) and cannot be displayed by this version.',
  'app.reload': 'Reload',
  'library.examples.heading': 'Start from an example',
  'library.examples.intro':
    'Each example opens as a new project of your own. Press Run to see real results.',
  'library.examples.open': 'Open example',
  'library.examples.openNamed': 'Open example: {name}',
  'library.import.button': 'Import project…',
  'library.import.label': 'Import a TBI Lab project file (.tbilab)',
  'library.actions': 'Actions for {name}',
  'library.open': 'Open {name}',
  'library.rename': 'Rename',
  'library.rename.label': 'New name for {name}',
  'library.rename.save': 'Save',
  'library.rename.cancel': 'Cancel',
  'library.duplicate': 'Duplicate',
  'library.export': 'Export',
  'library.delete': 'Delete',
  'library.delete.title': 'Delete this project?',
  'library.delete.body':
    '"{name}" will be permanently removed from this browser. Your other projects are not affected. This cannot be undone, so export the project first if you may need it again.',
  'library.delete.confirm': 'Delete project',
  'library.delete.cancel': 'Keep project',
  'library.copyName': '{name} (copy)',
  'library.copyNameN': '{name} (copy {n})',
  'library.error.nameTaken': 'A project named "{name}" already exists. Choose a different name.',
  'library.duplicated': 'Created "{name}".',
  'library.deleted': 'Deleted "{name}".',
  'library.error.rename': 'The project could not be renamed. It is unchanged; try again.',
  'library.error.duplicate':
    'The copy could not be created. The original project is unchanged; try again.',
  'library.error.delete':
    'The project could not be deleted. It is still in the list, unchanged; try again.',
  'library.error.create':
    "The project could not be created in this browser's storage. Nothing was changed; try again.",
  'library.error.newer':
    'This project was saved by a newer version of TBI Lab and cannot be changed or exported by this version.',
  'storage.error.read':
    "TBI Lab could not read this browser's project storage. Your projects have not been changed. Reload the page to try again.",
  'storage.error.quota':
    "This browser's storage for TBI Lab is full, so nothing new could be saved. Your existing projects are safe. Export or delete projects you no longer need, then try again.",
  'save.error.banner':
    'Your latest changes are not saved yet. They are still here in the editor. Try again, or export a copy to keep them safe.',
  'save.error.quotaBanner':
    'Browser storage is full, so your latest changes are not saved yet. They are still here in the editor. Export a copy, or delete projects you no longer need, then try again.',
  'export.button': 'Export',
  'export.title': 'Save this project as a portable .tbilab file',
  'export.error':
    'The project file could not be created. The project itself is unchanged; try again.',
  'import.done': 'Imported "{name}".',
  'import.doneCopy':
    'Imported "{name}" as a new copy, because a project with the same identity already exists in this browser. The existing project was not changed.',
  'import.doneRenamed':
    'Imported as "{name}", because a project named "{original}" already exists in this browser.',
  'import.doneCopyRenamed':
    'Imported as a new copy, "{name}", because this project already exists in this browser. The existing project was not changed.',
  'import.error.too_large':
    'This file is larger than 2 MB, far too large for a TBI Lab project. Nothing was imported.',
  'import.error.not_package':
    'This file is not a TBI Lab project file (.tbilab). Nothing was imported.',
  'import.error.damaged':
    'This project file is damaged or was changed outside TBI Lab, so it cannot be trusted. Nothing was imported.',
  'import.error.newer':
    'This project file was made by a newer version of TBI Lab. Update TBI Lab to open it. Nothing was imported.',
  'import.error.old':
    'This project file uses an old format that cannot be converted. Nothing was imported.',
  'import.error.invalid':
    'This project file contains a circuit TBI Lab cannot accept (for example an unknown component or an invalid value). Nothing was imported.',
  'import.error.read': 'The file could not be read. Nothing was imported.',
  'import.error.storage':
    "The project could not be saved in this browser's storage. Nothing was imported; try again.",
  'example.error': 'This example could not be opened.',
  'example.ohms-law.title': "Ohm's law",
  'example.ohms-law.summary':
    'A 5 V supply across 1 kΩ. Run it and read I = V / R = 5 mA, then change the resistance and run again.',
  'example.voltage-divider.title': 'Voltage divider',
  'example.voltage-divider.summary':
    'Two resistors split 9 V. The midpoint is 9 V × 20 kΩ / (10 kΩ + 20 kΩ) = 6 V; a probe at R2.a reads it.',
  'example.led-current.title': 'LED current limiting',
  'example.led-current.summary':
    'A 220 Ω resistor sets the current of a red LED from 5 V. The LED is nonlinear: it settles near 2 V and about 14 mA.',
  'example.diode-polarity.title': 'Diode polarity',
  'example.diode-polarity.summary':
    'Two identical branches with a 1N4148 diode. D1 is forward biased and conducts about 4.3 mA; D2 is reversed and blocks (a few nA).',
  'example.push-button.title': 'Momentary push button',
  'example.push-button.summary':
    'Press Run, then hold SW1: the LED lights only while the button is held. Pressing never changes the saved project.',
  'example.cc-mode.title': 'Current limit (CC mode)',
  'example.cc-mode.summary':
    '5 V with a 100 mA limit: 100 Ω draws 50 mA (CV). While running, close SW1 to add 10 Ω. That load would need 550 mA, so the supply holds 100 mA and its voltage drops (CC). This is normal, not a fault.',
  'palette.group.sources': 'Supply and reference',
  'palette.group.passive': 'Resistors',
  'palette.group.semiconductors': 'Diodes',
  'palette.group.switches': 'Switches',
  'inspector.shortcutsHeading': 'Keyboard shortcuts',
  'unit.watt.symbol': 'W',
  'sim.results.power': 'Power',
  'brand.logoAlt': 'TBI: Think, Bring ideas to life, Invent',
  'home.subtitle':
    'Circuits are simulated and saved right here in your browser. Start from an example, or create your own project.',
  'app.narrowScreen': 'TBI Lab is designed for desktop screens at least 1024 pixels wide.',
  'rating.heading': 'Component rating exceeded',
  'rating.atRisk': '{component} may be damaged',
  'rating.row.forward_current': 'Current: {value} (maximum {limit})',
  'rating.row.reverse_voltage': 'Reverse voltage: {value} (maximum {limit})',
  'rating.row.power': 'Power: {value} (maximum {limit})',
  'rating.note':
    'The simulation continues to show the calculated values and does not model physical damage.',

  // ---- Sprint 6: Classic ESP32 through the R2 Session Host ----
  'component.board.esp32_devkitc_wroom32.name': 'ESP32 DevKitC (Classic ESP32)',
  'param.firmware': 'Firmware',
  'firmware.tbi-gpio-proof.name': 'Blink GPIO2/GPIO18, report GPIO5',
  'firmware.tbi-gpio-proof.description':
    'Prebuilt test firmware: drives GPIO2 and GPIO18 in a repeating 800 ms pattern and prints the level of GPIO5 on the serial output.',
  'firmware.tbi-banks.name': 'Echo inputs to outputs (GPIO34→GPIO4, GPIO35→GPIO33)',
  'firmware.tbi-banks.description':
    'Prebuilt test firmware: sweeps GPIO4, 16, 25, 27, 32 and 33 once at start-up, then copies GPIO34 to GPIO4 and GPIO35 to GPIO33, printing each change.',
  'sim.status.runningMcu': 'Running · ESP32',
  'sim.status.stopping': 'Stopping…',
  'firmware.program': 'Its code (Build, then Run)',
  'sim.error.mcu_no_program': 'The board {components} has no code to run.',
  'sim.error.mcu_build_required':
    'Build required: build the code for {components}, then press Run.',
  'sim.error.mcu_unsupported_features':
    'The code for {components} uses features the simulator does not model: {features}. Run is refused.',
  'program.tab.circuit': 'Circuit',
  'program.tab.code': 'Code',
  // Sprint 9: generated views of the same circuit.
  'view.tabs': 'Project views',
  'view.tab.schematic': 'Schematic',
  'view.name.schematic': 'Schematic',
  'view.tab.3d': '3D',
  'view.loading': 'Loading…',
  'view.loadFailed': 'This view could not be loaded. The other views work as usual.',
  'schematic.aria': 'Schematic of {name}',
  'schematic.controls': 'Schematic view controls',
  'schematic.note': 'Generated from the circuit. Edit in the Circuit view.',
  'view3d.aria': '3D view of {name}',
  'view3d.controls': '3D view controls',
  'view3d.reset': 'Reset camera',
  'view3d.rotateLeft': 'Rotate left',
  'view3d.rotateRight': 'Rotate right',
  'view3d.loading': 'Loading the 3D view…',
  'view3d.unavailable':
    'The 3D view needs WebGL, which this browser or device does not provide. The circuit, schematic and code views work as usual.',
  'view3d.loadFailed': 'The 3D view could not be loaded. The other views work as usual.',
  'view3d.note':
    'A visualization of the circuit: drag or ← → to rotate; right-drag, Shift-drag or Shift + arrows to pan; scroll or + − to zoom. Edit in the Circuit view.',
  'program.editor.label': 'Arduino source code of {board}',
  'program.position': 'Line {line}, column {column}',
  'program.size': '{used} of {max}',
  'build.button': 'Build',
  'build.phase.required': 'Build required',
  'build.phase.building': 'Building…',
  'build.phase.queued': 'Waiting to build ({position} ahead)',
  'build.phase.current': 'Built',
  'build.phase.failed': 'Build failed',
  'build.stale': 'The code changed since the last build.',
  'build.blockedRunning':
    'Build is available after Stop. The running session keeps the firmware it started with.',
  'build.unavailable': 'The build service is not available here.',
  'build.error.unreachable': 'Could not reach the build service. Your code is safe; try again.',
  'build.error.busy': 'The build service is busy. Try again in a moment.',
  'build.error.quota':
    'You already have a build in progress and one waiting. Wait for them to finish.',
  'build.error.rate_limited': 'Too many builds in a short time. Try again in a few minutes.',
  'build.error.cooldown':
    'Several builds failed in a row. Wait a few minutes before building again.',
  'build.error.storage_quota':
    'Your saved builds are at their limit and are all in use. Stop the running session, then build again.',
  'build.error.capability_disabled': 'Running a prebuilt binary is not available for your account.',
  'build.error.refused': 'The build service refused this request.',
  'build.error.too_large': 'The code is too large to build (the limit is 64 KiB).',
  'build.error.not_an_image': 'The build service could not use this file.',
  'build.error.protocol':
    'Unexpected answer from the build service. Try again, or reload the page.',
  'build.failure.timeout': 'The build took longer than the time limit and was stopped.',
  'build.failure.storage_limit': 'The build used too much temporary storage and was stopped.',
  'build.failure.unsupported_input': 'This code cannot be built in this environment.',
  'build.failure.internal': 'The build service had an internal problem. Try again.',
  'build.failure.capacity_timeout':
    'The build waited too long for the build service and did not start. Try again.',
  'build.diagnostics.heading': 'Problems',
  'build.severity.error': 'Error',
  'build.severity.warning': 'Warning',
  'build.severity.note': 'Note',
  'build.details': 'Build details',
  'build.artifact': 'Firmware image {id}',
  'build.sizes': 'Program {program} of {programMax} bytes · RAM {data} of {dataMax} bytes',
  'build.features.note':
    'This code uses features the simulator does not model, so Run is refused until they are removed:',
  'build.feature.internal_pull': 'internal pull-up/pull-down',
  'build.feature.interrupt': 'GPIO interrupts',
  'build.feature.restart': 'chip restart',
  'build.feature.wifi': 'Wi-Fi networking',
  'build.feature.bluetooth': 'Bluetooth',
  'build.feature.adc': 'analog input (ADC)',
  'build.feature.pwm': 'PWM/LEDC output',
  'build.feature.dac': 'analog output (DAC)',
  'build.feature.touch': 'touch sensing',
  'build.feature.sleep': 'sleep modes',
  'build.feature.i2c': 'I2C bus',
  'build.feature.spi': 'SPI bus',
  'build.feature.library': 'library {name}',
  'mcu.runs.program': 'Runs its code. Edit it in the Code tab, Build, then Run.',
  'mcu.runs.reference': 'Runs the reference firmware “{name}”.',
  'mcu.runs.useProgram': 'Use its code instead',
  'mcu.advanced.heading': 'Advanced',
  'mcu.advanced.runPrebuilt': 'Run prebuilt binary…',
  'mcu.advanced.note':
    'For an image built outside TBI Lab: a merged 4 MB Classic ESP32 flash image (.bin). It is not analysed, so features the simulator does not model are only detected while it runs. It is not saved in the project.',
  'mcu.advanced.error.not_an_image': 'This file is not a merged 4 MB Classic ESP32 flash image.',
  'mcu.advanced.error.too_large': 'This file is larger than a 4 MB flash image.',
  'mcu.advanced.error.unreachable': 'Could not reach the build service to upload the image.',
  'mcu.advanced.error.busy': 'The build service is busy. Try again in a moment.',
  'mcu.advanced.error.refused': 'The build service refused the image.',
  'mcu.advanced.error.protocol': 'Unexpected answer from the build service.',
  'sim.error.mcu_multiple': 'This version runs one ESP32 board per project. Found: {components}.',
  'sim.error.mcu_unknown_firmware':
    'The firmware selected for {components} is not available in this version. Select another firmware.',
  'sim.error.mcu_ground_unconnected':
    'Connect the GND pin of {components} to [[ground]], then press Run.',
  'sim.error.mcu_pin_without_circuit':
    '{pins} of {components} connect only to other pins of the board. Connect them through a circuit element (for example a resistor).',
  'sim.error.runtime.session_create_failed':
    'Could not start an ESP32 session: the runtime service is not reachable. The project is not affected.',
  'sim.error.runtime.runtime_busy':
    'The ESP32 runtime service is busy. Try again in a moment. The project is not affected.',
  'sim.error.runtime.session_quota':
    'You already have an ESP32 session running. Stop it before starting another. The project is not affected.',
  'sim.error.runtime.rate_limited':
    'Too many ESP32 sessions were started in a short time. Try again in a few minutes. The project is not affected.',
  'sim.error.runtime.firmware_unavailable':
    'The selected firmware is not available on the runtime service. The project is not affected.',
  'sim.error.runtime.unsupported_feature':
    'The firmware uses a feature the simulator does not support in this version (internal pull-up/pull-down or GPIO interrupts).',
  'sim.error.runtime.invalid_attachment': 'A connected ESP32 pin cannot be used in the simulator.',
  'sim.error.runtime.startup_failed':
    'The ESP32 could not start. The project is not affected. Press Run to try again.',
  'sim.error.runtime.runtime_crashed':
    'The ESP32 runtime stopped unexpectedly and the session ended. The project is not affected.',
  'sim.error.runtime.guest_reset':
    'The firmware requested a chip reset, which the simulator does not support. The session ended; press Run for a fresh start.',
  'sim.error.runtime.stalled':
    'The ESP32 stopped making progress (for example, the firmware image does not boot). The session ended.',
  'sim.error.runtime.session_lost':
    'The ESP32 session was lost (connection lost or session expired). The project is safe; press Run for a fresh session.',
  'sim.error.runtime.session_expired':
    'The ESP32 session reached its maximum duration and ended. Press Run for a fresh session.',
  'sim.error.runtime.mirror_failed':
    'The running ESP32 session could not apply your change, so it was stopped. The project keeps your change.',
  'sim.error.runtime.protocol_error':
    'The runtime service sent an unexpected response and the session ended. The project is not affected.',
  'mcu.heading': 'ESP32 runtime',
  'mcu.notRunning': 'Press Run to see live pin levels and serial output.',
  'mcu.pins.heading': 'Pins',
  'mcu.pins.pin': 'Pin',
  'mcu.pins.support': 'Simulator support',
  'mcu.pins.state': 'Live',
  'mcu.support.digital-io': 'Digital I/O',
  'mcu.support.digital-input': 'Input only',
  'mcu.support.none': 'Not available',
  'mcu.caveat.strapping': 'Strapping pin: boot level is not sampled; always boots from flash',
  'mcu.caveat.flash': 'Connected to the module flash',
  'mcu.caveat.console': 'Serial console (UART0)',
  'mcu.caveat.inputOnly': 'No output driver, no internal pull',
  'mcu.caveat.power': 'Supply pin',
  'mcu.caveat.enable': 'Chip enable: reset is not simulated',
  'mcu.note.unsupported':
    'Not simulated in this version: internal pull-up/pull-down, GPIO interrupts, chip reset, analog, PWM, Wi-Fi.',
  'mcu.level.high': 'HIGH',
  'mcu.level.low': 'LOW',
  'mcu.mode.output': 'output',
  'mcu.mode.input': 'input',
  'mcu.serial.heading': 'Serial output',
  'mcu.serial.empty': 'No output yet.',
  'mcu.serial.dropped': 'Older output was trimmed ({count} characters).',
  'mcu.terminal.heading': 'ESP32 terminal',
  'mcu.terminal.idle':
    'Press Run to start the ESP32. Its serial console output appears here, from boot.',
  'mcu.terminal.simTime': '{time} simulated',
  'mcu.terminal.state.idle': 'Not running',
  'mcu.terminal.state.starting': 'Starting session…',
  'mcu.terminal.state.booting': 'Booting…',
  'mcu.terminal.state.running': 'Running',
  'mcu.terminal.state.reconnecting': 'Reconnecting…',
  'mcu.terminal.state.stopping': 'Stopping…',
  'mcu.terminal.state.failed': 'Session failed',
  'mcu.terminal.state.ended': 'Session ended (last output)',
  'mcu.warnings.heading': 'Runtime warnings',
  'mcu.warning.output_on_input_only_pad':
    'GPIO{gpio} is input-only: the firmware tried to drive it, and it stays an input.',
  'mcu.warning.transient_rejected': 'A button press could not be delivered to the running session.',
  'mcu.warning.generic': 'Runtime warning: {code}',
  'mcu.connection.reconnecting': 'Reconnecting to the ESP32 session…',
  'mcu.resync':
    '{count} runtime updates were missed while reconnecting. Values refresh on the next change.',
  'mcu.firmware.label': 'Firmware',
  'example.esp32-blink.title': 'ESP32: blink an LED',
  'example.esp32-blink.summary':
    'A Classic ESP32 runs prebuilt firmware that switches GPIO2 on and off; the LED on GPIO2 blinks. Runs on the ESP32 runtime service.',
  'example.esp32-input-echo.title': 'ESP32: switch input to LED output',
  'example.esp32-input-echo.summary':
    'Close the switch or hold the button: 3.3 V reaches GPIO34, the firmware copies it to GPIO4 and the LED lights. Runs on the ESP32 runtime service.',
  'palette.group.mcu': 'Microcontroller',
  // Board pin silkscreen names (Sprint 6): technical tokens, verbatim in every locale.
  'pin.gpio36': 'VP',
  'pin.gpio39': 'VN',
  'pin.gpio34': 'IO34',
  'pin.gpio35': 'IO35',
  'pin.gpio32': 'IO32',
  'pin.gpio33': 'IO33',
  'pin.gpio25': 'IO25',
  'pin.gpio26': 'IO26',
  'pin.gpio27': 'IO27',
  'pin.gpio14': 'IO14',
  'pin.gpio12': 'IO12',
  'pin.gpio13': 'IO13',
  'pin.gnd': 'GND',
  'pin.gpio23': 'IO23',
  'pin.gpio22': 'IO22',
  'pin.gpio21': 'IO21',
  'pin.gpio19': 'IO19',
  'pin.gpio18': 'IO18',
  'pin.gpio5': 'IO5',
  'pin.gpio17': 'IO17',
  'pin.gpio16': 'IO16',
  'pin.gpio4': 'IO4',
  'pin.gpio0': 'IO0',
  'pin.gpio2': 'IO2',
  'pin.gpio15': 'IO15',
} as const;

export type MessageKey = keyof typeof en;
