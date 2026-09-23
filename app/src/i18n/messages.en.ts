/**
 * English message catalogue. The key set defined here is the contract every other locale
 * must satisfy completely (enforced by the type of `he` and by tests/i18n.test.ts).
 */
export const en = {
  'app.loading': 'Loading…',
  'app.storageUnavailable':
    'Local storage is not available in this browser, so projects cannot be saved.',

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

  'open.error.invalid': 'This project is damaged and cannot be opened.',
  'open.error.unmigratable': 'This project uses an older format that cannot be converted.',
  'open.error.missing': 'This project no longer exists in this browser.',
  'readonly.newer':
    'This project was saved by a newer version of TBI Lab (format {version}). It is open read-only and changes are not saved.',
  'readonly.unreadable':
    'This project was saved by a newer version of TBI Lab (format {version}) and cannot be displayed by this version.',
} as const;

export type MessageKey = keyof typeof en;
