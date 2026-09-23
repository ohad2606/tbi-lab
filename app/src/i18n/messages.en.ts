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
  'canvas.componentLabel': '{ref}, {type}',
  'canvas.junctionLabel': 'Junction {id}',

  'component.instrument.lab_psu.name': 'Lab power supply',
  'component.component.ground.name': 'Ground',
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
