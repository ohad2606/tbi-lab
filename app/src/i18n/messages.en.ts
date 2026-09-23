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
  'home.new.create': 'Create project',
  'home.recent.heading': 'Recent projects',
  'home.recent.empty': 'No projects yet. Create one to get started.',
  'home.recent.updated': 'Last changed {date}',
  'home.browserNote': 'Projects are saved in this browser on this device.',

  'topbar.projects': 'Projects',
  'topbar.projectName': 'Project name',
  'topbar.language': 'Language',

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

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',

  'sim.run': 'Run',
  'sim.stop': 'Stop',
  'sim.controls': 'Simulation',
  'sim.status.stopped': 'Stopped',
  'sim.status.starting': 'Starting…',
  'sim.status.running': 'Running · DC operating point',
  'sim.status.failed': 'Could not run',
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
  'sim.error.invalid_parameter': '{components}: the value of “{param}” cannot be simulated.',
  'sim.error.unsupported_component': '{components} cannot be simulated yet.',
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
} as const;

export type MessageKey = keyof typeof en;
