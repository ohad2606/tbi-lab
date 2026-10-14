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

  // ---- Sprint 10: approved component families (PM-6 revision) ----
  'component.component.rgb_led.name': 'RGB LED',
  'component.component.photoresistor.name': '[[photoresistor]]',
  'component.component.buzzer.name': '[[buzzer]]',
  'component.component.relay.name': '[[relay]]',
  'terminal.red': 'Red anode (R)',
  'terminal.green': 'Green anode (G)',
  'terminal.blue': 'Blue anode (B)',
  'terminal.commonCathode': 'Common cathode (K)',
  'terminal.coil1': 'Coil (A1)',
  'terminal.coil2': 'Coil (A2)',
  'terminal.com': 'Common (COM)',
  'terminal.no': 'Normally open (NO)',
  'terminal.nc': 'Normally closed (NC)',
  'param.illuminance': 'Light on the cell (illuminance)',
  'model.rgb_led.kingbright_wp154a4sureqbfzgc':
    'Common cathode 5 mm (Kingbright WP154A4SUREQBFZGC)',
  'model.ldr.senba_gl5528': 'CdS cell 5 mm (GL5528)',
  'model.buzzer.cui_cem_1205_ic': 'Active 5 V, 12 mm (CUI Devices CEM-1205-IC)',
  'model.relay.songle_srd_05vdc_sl_c': '5 V coil, SPDT (Songle SRD-05VDC-SL-C)',
  'sim.part.current.red': 'Red channel current',
  'sim.part.current.green': 'Green channel current',
  'sim.part.current.blue': 'Blue channel current',
  'sim.part.current.coil': 'Coil current',
  'sim.part.current.contact': 'Contact current (COM)',
  'sim.part.state.energized': 'Relay energized',
  'sim.part.state.contact': 'COM connected to',
  'sim.part.state.contact.no': 'NO (normally open)',
  'sim.part.state.contact.nc': 'NC (normally closed)',
  'sim.part.state.sounding': 'Sounding',
  'sim.part.state.resistance': 'Resistance at this light level',
  'component.component.bjt_npn.name': 'NPN [[transistor]]',
  'terminal.collector': 'Collector (C)',
  'terminal.base': 'Base (B)',
  'terminal.emitter': 'Emitter (E)',
  'model.bjt.fairchild_2n3904': '2N3904 general purpose (Fairchild SPICE model)',
  'sim.part.current.collector': 'Collector current',
  'sim.part.current.base': 'Base current',
  'sim.part.current.emitter': 'Emitter current',
  'sim.part.current.vce': 'Collector–emitter',
  'sim.part.current.vcb': 'Collector–base',
  'sim.part.current.veb': 'Emitter–base (reverse)',
  'sim.part.state.region': 'Operating region',
  'sim.part.state.region.cutoff': 'cut-off',
  'sim.part.state.region.active': 'forward active (amplifying)',
  'sim.part.state.region.saturation': 'saturation (switched on)',
  'sim.part.state.region.reverse': 'reverse active',
  'sim.part.short.collector': 'I_C',
  'sim.part.short.base': 'I_B',
  'sim.part.short.emitter': 'I_E',
  'sim.part.voltage.component.bjt_npn': 'Collector–emitter voltage (V_CE)',
  'component.sensor.pir_hc_sr501.name': 'PIR motion sensor',
  'terminal.moduleGnd': 'Ground (GND)',
  'terminal.out': 'Output (OUT)',
  'terminal.vcc': 'Supply (VCC)',
  'param.motion': 'Motion in front of the sensor',
  'model.pir.hc_sr501': 'HC-SR501 module (BISS0001, 3.3 V output)',
  'sim.part.current.supply': 'Supply current',
  'sim.part.current.output': 'Output current',
  'sim.part.state.powered': 'Powered (supply 4.5–20 V)',
  'sim.part.state.output': 'Output',
  'sim.part.state.output.high': 'HIGH (motion detected)',
  'sim.part.state.output.low': 'LOW',
  'component.display.led_matrix_8x8.name': 'LED matrix 8×8',
  'model.led_matrix.oasis_1088as': 'Red, 3 mm dots, 32 mm (1088AS)',
  'sim.part.state.lit': 'Dots lit',
  'terminal.row1': 'Row 1 (dot cathodes)',
  'terminal.row2': 'Row 2 (dot cathodes)',
  'terminal.row3': 'Row 3 (dot cathodes)',
  'terminal.row4': 'Row 4 (dot cathodes)',
  'terminal.row5': 'Row 5 (dot cathodes)',
  'terminal.row6': 'Row 6 (dot cathodes)',
  'terminal.row7': 'Row 7 (dot cathodes)',
  'terminal.row8': 'Row 8 (dot cathodes)',
  'terminal.col1': 'Column 1 (dot anodes)',
  'terminal.col2': 'Column 2 (dot anodes)',
  'terminal.col3': 'Column 3 (dot anodes)',
  'terminal.col4': 'Column 4 (dot anodes)',
  'terminal.col5': 'Column 5 (dot anodes)',
  'terminal.col6': 'Column 6 (dot anodes)',
  'terminal.col7': 'Column 7 (dot anodes)',
  'terminal.col8': 'Column 8 (dot anodes)',
  'component.component.capacitor.name': 'Capacitor',
  'param.capacitance': 'Capacitance',
  'param.ratedVoltage': 'Rated voltage',
  'sim.part.state.charge': 'Stored charge (coulomb)',
  'sim.part.state.energy': 'Stored energy (joule)',
  // ---- Sprint 12: R2 sensors and the R3 I2C display ----
  'component.sensor.hc_sr04.name': 'Ultrasonic distance sensor',
  'component.sensor.dht22.name': 'Temperature and humidity sensor',
  'component.display.lcd1602_i2c.name': 'Character LCD 16×2 (I2C)',
  'terminal.trig': 'Trigger input (TRIG)',
  'terminal.echo': 'Echo output (ECHO)',
  'terminal.vdd': 'Supply (VDD)',
  'terminal.data': 'Data (DATA)',
  'terminal.notConnected': 'Not connected (NC)',
  'terminal.sda': 'I2C data (SDA)',
  'terminal.scl': 'I2C clock (SCL)',
  'param.distance': 'Distance to the target',
  'param.airTemperature': 'Air temperature',
  'param.temperature': 'Temperature',
  'param.humidity': 'Relative humidity',
  'param.i2cAddress': 'I2C address',
  'model.ultrasonic.hc_sr04': 'HC-SR04 module (5 V, 40 kHz)',
  'model.humidity.am2302': 'DHT22 / AM2302 (Aosong, 3.3–6 V)',
  'model.lcd.lcd1602_pcf8574': 'HD44780 16×2 with PCF8574 I2C backpack',
  'i2c.0x20': '0x20',
  'i2c.0x21': '0x21',
  'i2c.0x22': '0x22',
  'i2c.0x23': '0x23',
  'i2c.0x24': '0x24',
  'i2c.0x25': '0x25',
  'i2c.0x26': '0x26',
  'i2c.0x27': '0x27',
  'sim.part.state.output.off': 'not driven (unpowered)',
  'sim.part.state.output.released': 'released (not driven by the sensor)',
  'sim.part.state.sensor.hc_sr04.powered': 'Powered (supply at least 4.5 V)',
  'sim.part.state.sensor.hc_sr04.output': 'ECHO output',
  'sim.part.state.sensor.hc_sr04.output.high': 'HIGH (echo pulse)',
  'sim.part.state.sensor.dht22.powered': 'Powered (supply at least 3.3 V)',
  'sim.part.state.sensor.dht22.output': 'DATA line (sensor side)',
  'sim.part.state.sensor.dht22.output.low': 'LOW (pulled low by the sensor)',
  'sim.part.state.display.lcd1602_i2c.powered': 'Powered',
  'sim.part.state.backlight': 'Backlight on',
  'sim.part.state.displayOn': 'Display on',
  'sim.part.state.line1': 'Line 1',
  'sim.part.state.line2': 'Line 2',
  'lcd.screen': 'Display contents, line 1: {line1}; line 2: {line2}',
  'lcd.blank': 'Display blank',
  'sim.time': 't = {time}',
  'sim.timeNote':
    'Simulated time since Run (1 ms steps). Capacitors start discharged at every Run.',
  'sim.timeBehind': 'running slower than real time',
  'sim.part.short.red': 'R',
  'sim.part.short.green': 'G',
  'sim.part.short.blue': 'B',
  'rating.row.current': 'Current: {value} (maximum {limit})',
  'rating.row.voltage': 'Voltage: {value} (maximum {limit})',
  'rating.channel': '{channel} — {row}',

  'unit.ohm.symbol': 'Ω',
  'unit.volt.symbol': 'V',
  'unit.ampere.symbol': 'A',
  'unit.lux.symbol': 'lx',
  'unit.farad.symbol': 'F',
  'unit.metre.symbol': 'm',
  'unit.celsius.symbol': '°C',
  'unit.percent_rh.symbol': '%RH',

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
  'sim.error.no_steady_state':
    'This circuit has no steady state: {components} keeps switching itself on and off (a relay that interrupts its own coil chatters). A DC simulation cannot show one of its transitory states.',
  'sim.error.mcu_component_unsupported':
    'The ESP32 simulator does not support {components} yet. These parts simulate in circuits without an ESP32; with the board they need a runtime update.',
  'sim.error.mcu_component_time_dependent':
    '{components} behave over time, and the ESP32 simulator does not step time. They are simulated only in circuits without an ESP32.',
  'sim.error.internal': 'An internal simulation error occurred. The project is not affected.',
  'sim.error.worker_crashed':
    'The simulation stopped unexpectedly. The project is not affected. Press Run to try again.',
  'sim.error.timeout':
    'The simulation did not respond in time and was stopped. The project is not affected. Press Run to try again.',
  'sim.notConnected': 'Not connected, not simulated: {components}',
  'sound.off': 'Sound: off',
  'sound.on': 'Sound: on',
  'sound.off.hint': 'Hear sounding buzzers (presentation only; off by default)',
  'sound.on.hint': 'Mute buzzers',
  'sim.part.yes': 'yes',
  'sim.part.no': 'no',
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
  'inspector.environment': 'Simulated environment',
  'inspector.environmentNote':
    'What this part senses around it. A simulation control, not a property of the part; it can change while running.',
  'inspector.heading': 'Properties',
  'inspector.empty': 'Nothing selected. Select a component to see and edit its properties.',
  'inspector.multi': '{count} items selected',
  'inspector.reference': 'Reference',
  'inspector.type': 'Type',
  'inspector.rotate': 'Rotate 90°',
  'inspector.delete': 'Delete',
  'inspector.wire': 'Wire',
  'inspector.junction': 'Junction',
  'inspector.wireColor': 'Wire color',
  'wireColor.auto': 'Auto',
  'wireColor.autoIs': 'Auto ({color})',
  'wireColor.red': 'Red',
  'wireColor.black': 'Black',
  'wireColor.orange': 'Orange',
  'wireColor.blue': 'Blue',
  'wireColor.green': 'Green',
  'wireColor.purple': 'Purple',
  'wireColor.yellow': 'Yellow',
  'wireColor.teal': 'Teal',
  'wireColor.brown': 'Brown',
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
  // OS-12: search and category filters for the examples.
  'library.examples.search': 'Search examples',
  'library.examples.searchHint': 'e.g. LED, sensor, ESP32 LCD, LDR',
  'library.examples.categories': 'Categories',
  'library.examples.category.basic': 'Basic circuits',
  'library.examples.category.sensors': 'Sensors',
  'library.examples.category.lighting': 'Lighting and displays',
  'library.examples.category.controllers': 'Controllers and programming',
  'library.examples.category.switching': 'Switching and control',
  'library.examples.count': 'Showing {shown} of {total} examples',
  'library.examples.empty': 'No example matches. Try fewer or other words, or clear the filters.',
  'library.examples.clear': 'Clear filters',
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
  'example.rgb-mixer.title': 'RGB LED: mixing colour with currents',
  'example.rgb-mixer.summary':
    'One common-cathode RGB LED, each channel through its own switch and resistor. Flip the switches while it runs: the colour is the mix of the currents the circuit drives.',
  'example.light-sensor.title': 'Light sensor: a photoresistor divider',
  'example.light-sensor.summary':
    'A GL5528 photoresistor over 10 kΩ from 9 V. Change the simulated light on the cell in the inspector and watch the divider voltage follow.',
  'example.relay-load.title': 'Relay: a small current switches a separate load',
  'example.relay-load.summary':
    'Press the button to energize the relay coil (about 71 mA). Its contacts move from NC (buzzer) to NO (LED): the coil and the load are separate circuits.',
  'example.night-light.title': 'Night light: a transistor switched by light',
  'example.night-light.summary':
    'A photoresistor divider biases a 2N3904. Lower the simulated light on the cell: the base voltage rises, the transistor turns on and the LED in its collector lights.',
  'example.pir-alarm.title': 'PIR alarm: motion sounds a buzzer',
  'example.pir-alarm.summary':
    'An HC-SR501 motion sensor drives a 2N3904 that switches a buzzer. Run it, then click the sensor dome (or tick the motion box) to put motion in front of it.',
  'example.led-matrix.title': 'LED matrix: rows and columns',
  'example.led-matrix.summary':
    'Two columns are driven from 5 V through 220 Ω; switches ground two rows. A dot lights only where a driven column meets a grounded row: the principle behind scanning a matrix.',
  'example.rc-fade.title': 'RC timing: an LED that fades',
  'example.rc-fade.summary':
    'A 2200 µF capacitor charges through 1 kΩ and feeds an LED. Run: the LED fades in as the capacitor charges. Open the switch: it fades out as the capacitor discharges. Simulated time runs from Run.',
  'example.led-colours.title': 'LED colours: one resistor, different currents',
  'example.led-colours.summary':
    'Red, yellow and green LEDs, each from 5 V through 180 Ω. Each colour has its own forward voltage (about 2.0 V red, 2.4 V yellow and green), so the same resistor sets about 16.7 mA through the red LED and 14.5 mA through the others.',
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
  'palette.unavailable.part_needs_runtime': 'Requires runtime support not available for ESP32 yet.',
  'palette.unavailable.board_needs_runtime':
    'Not available while the project has parts the ESP32 runtime does not support yet.',
  'palette.unavailable.part_time_dependent':
    'Time-dependent parts are simulated only in circuits without an ESP32.',
  'palette.unavailable.board_time_dependent':
    'Not available while the project has time-dependent parts (they are simulated only without an ESP32).',
  'palette.group.sensors': 'Sensors',
  'palette.group.output': 'Sound and displays',
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
  'rating.row.gpio_source_current': '{pin} output HIGH sources {value} (typical drive {limit})',
  'rating.row.gpio_sink_current': '{pin} output LOW sinks {value} (typical drive {limit})',
  'rating.row.gpio_contention':
    '{pin} and {other} drive opposite levels on the same net: {value} flows between them (typical drive {limit})',
  'rating.row.gpio_short_ground':
    '{pin} output HIGH is wired straight to GND: {value} (typical drive {limit})',
  'rating.row.gpio_short_supply':
    '{pin} output LOW is wired straight to a supply +: {value} (typical drive {limit})',
  'rating.row.gpio_output_overvoltage':
    '{pin} output is forced to {value} by the circuit (limit {limit}); current is pushed into the pin driver',
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
  'version.aria': 'Build {version}: show details',
  'version.product': 'Product',
  'version.version': 'Version',
  'version.environment': 'Environment',
  'version.commit': 'Commit',
  'version.builtAt': 'Built',
  'version.runtime': 'Runtime ID',
  'version.runtimeUnknown': 'not reported by the backend',
  'version.graphics': '3D graphics',
  'version.tierFull': 'full quality',
  'version.tierReduced': 'reduced quality',
  'version.noWebgl': 'WebGL not available',
  'footer.aria': 'Product information and build',
  'footer.developedBy': 'Developed by Ohad David',
  'footer.rights': 'All rights reserved.',
  'footer.supportLabel': 'Email support: {email}',
  'update.available': 'A new version is available',
  'update.reload': 'Reload',
  'update.later': 'Later',
  'update.busySimulation': 'Stop the simulation to reload.',
  'update.busyBuild': 'Reload when the build has finished.',
  'update.busySaving': 'Saving your changes…',
  // 3D rendering diagnostics (development readout, opened with #diag3d).
  'view3d.diag.gpu': 'WebGL renderer',
  'view3d.diag.class': 'Graphics',
  'view3d.diag.software': 'software (no GPU)',
  'view3d.diag.hardware': 'hardware GPU',
  'view3d.diag.tier': 'Quality tier',
  'view3d.diag.dpr': 'Pixel ratio',
  'view3d.diag.drawCalls': 'Draw calls',
  'view3d.diag.triangles': 'Triangles',
  'view3d.diag.materials': 'Materials',
  'view3d.diag.textures': 'Textures',
  'view3d.diag.geometries': 'Geometries',
  'view3d.diag.gpuMemory': 'GPU memory (est.)',
  'view3d.diag.frame': 'Last frame (CPU)',
  'view3d.diag.mode': 'Visual mode',
  'view3d.diag.dof': 'Depth of field',
  'view3d.presets': 'Standard views',
  // 3D visualization layers (layers.ts): the physical scene plus optional engineering layers.
  'view3d.layers': 'Layers',
  'view3d.layers.aria': 'Visualization layers',
  'view3d.preset.realistic': 'Realistic',
  'view3d.preset.engineering': 'Engineering',
  'view3d.preset.custom': 'Custom',
  'view3d.layer.labels': 'Labels',
  'view3d.layer.grid': 'Grid',
  'view3d.layer.dof': 'Depth of field',
  'view3d.layers.lens': 'Camera',
  'view3d.dof.unavailable': 'Needs a hardware GPU',
  'view3d.mode': 'Visual mode',
  'view3d.view.top': 'Top',
  'view3d.view.front': 'Front',
  'view3d.view.side': 'Side',
  'view3d.view.rear': 'Rear',
  'view3d.reset': 'Reset camera',
  'view3d.rotateLeft': 'Rotate left',
  'view3d.rotateRight': 'Rotate right',
  'view3d.loading': 'Loading the 3D view…',
  'view3d.unavailable':
    'The 3D view needs WebGL, which this browser or device does not provide. The circuit, schematic and code views work as usual.',
  'view3d.loadFailed': 'The 3D view could not be loaded. The other views work as usual.',
  'view3d.control.toggle': 'Toggle switch {id}, {state}',
  'view3d.control.momentary': 'Push button {id}, {state}',
  'view3d.control.stopped': 'Run the simulation to operate it.',
  'view3d.controlsHint': 'Running: click a lever to toggle it; press and hold a button.',
  'view3d.note':
    'A visualization of the circuit: drag or ← → to rotate; right-drag, Shift-drag or Shift + arrows to pan; scroll or + − to zoom. Edit in the Circuit view.',
  'view3d.overlap':
    'Some parts are larger in 3D than their symbols and still touch here ({parts}). Move them further apart in the Circuit view.',
  'program.editor.label': 'Arduino source code of {board}',
  'program.position': 'Line {line}, column {column}',
  'program.size': '{used} of {max}',
  'build.button': 'Build',
  'toolbar.build': 'Build',
  'toolbar.build.group': 'Build the code',
  'toolbar.build.readOnly': 'This project is read-only: it cannot be built here.',
  'toolbar.build.error': 'Build not completed',
  'toolbar.build.showProblems': 'Show problems',
  'build.phase.required': 'Build required',
  'build.phase.building': 'Building…',
  'build.phase.queued': 'Waiting to build ({position} ahead)',
  'build.phase.current': 'Built',
  'build.phase.failed': 'Build failed',
  'build.stale': 'The code changed since the last build.',
  // Sprint 13 OS-08: Run is not available during a build or without a current build.
  'run.blocked.building': 'Run is unavailable while a build is in progress.',
  'run.blocked.buildRequired':
    'Build the code for {components} first: it has not been built, or it changed since the last build.',
  'run.blocked.buildFailed':
    'The last build of the code for {components} failed. Fix it and Build.',
  'build.olderRunning':
    'A build of an earlier version of this code is still in progress. Build the current version when it finishes.',
  // Sprint 13 OS-04: component bodies may not overlap (Circuit view and its 3D view).
  'edit.overlap.circuit':
    '{a} would overlap {b}. Place it where the parts do not cover each other.',
  'edit.overlap.3d':
    '{a} would overlap {b} at their real size (as the 3D view shows them). Leave more room between them.',
  'edit.overlap.both': '{a} would overlap {b}. Place it where the parts do not cover each other.',
  // Sprint 13 Task D: the project changed or was deleted in another tab or window.
  'save.error.conflictBanner':
    'This project was changed or deleted in another tab or window, so the changes here were not saved. To keep them, use Export now; then reload to continue with the saved version.',
  'save.reload': 'Reload',
  // OS-11: the gate's sign-in expired; background requests never start a login themselves.
  'auth.expired':
    'Your sign-in has expired. Your projects are saved in this browser. Sign in again to continue.',
  'auth.signInAgain': 'Sign in again',
  // Sprint 13 Task D: wire routes adjusted when a project opened (layout only).
  'open.routesAdjusted':
    'Some wire routes were redrawn so they no longer run over pins or displays. Connections are unchanged. Undo restores the previous routes.',
  // Sprint 13 a11y: the slider's own accessible name (distinct from its value field).
  'valueControl.slider': '{label}, slider',
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
  'build.feature.drive_strength': 'pin drive strength selection (gpio_set_drive_capability)',
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
  'sim.runtime.expiring':
    'This ESP32 session will end within a minute (a session lasts at most {minutes} min). Your project is saved; afterwards, press Run for a fresh session.',
  'sim.error.runtime.session_expired':
    'The ESP32 session reached its maximum duration and ended. Press Run for a fresh session.',
  'sim.error.runtime.mirror_failed':
    'The running ESP32 session could not apply your change, so it was stopped. The project keeps your change.',
  'sim.error.runtime.command_refused':
    'The ESP32 runtime refused a live change it does not support (it may be older than this app), so the session was stopped. The project keeps your change.',
  'sim.error.runtime.commands_rate_limited':
    'Live changes were sent faster than the ESP32 runtime accepts, so the session was stopped. The project keeps your change; press Run to continue.',
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
  // Sprint 13 OS-09: I2C diagnostics, specific and actionable.
  'mcu.warning.i2c_wiring.supply_pin':
    "{component}: {gpio} ({line}) is wired to the module's {terminal} pin, not to {line}. Check the module's pins: VCC and {line} may be swapped. The module does not respond.",
  'mcu.warning.i2c_wiring.swapped':
    '{component}: SDA and SCL are swapped ({sda} is on SCL, {scl} on SDA). The module does not respond.',
  'mcu.warning.i2c_no_pullup':
    '{component}: {lines} has no pull-up resistor, so the bus cannot idle high. Add a pull-up to each line.',
  'mcu.warning.i2c_logic_level':
    "{component}: {lines} idles at a level the module or the ESP32 does not read as HIGH. Pull the lines up to a voltage both accept (the module's input threshold is 0.7 × its supply).",
  'mcu.warning.i2c_rate_exceeded':
    'The I2C traffic exceeds what the simulator processes per simulated second; further transfers are not acknowledged.',
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
  'example.esp32-bench.title': 'ESP32 bench: inputs and indicators',
  'example.esp32-bench.summary':
    'The switch input to LED output circuit on a fuller bench: a red LED driven by GPIO4, and yellow (behind a 1N4148 diode) and green indicators fed straight from the 3.3 V supply. Runs on the ESP32 runtime service.',
  'example.esp32-motion-relay.title': 'ESP32: motion alarm through a relay',
  'example.esp32-motion-relay.summary':
    'A PIR motion sensor on GPIO34; the firmware copies it to GPIO4, which switches a 2N3904 and a 5 V relay (with a flyback diode). The relay contact sounds the buzzer and lights the alarm LED. Click the sensor dome while running to put motion in front of it. Runs on the ESP32 runtime service.',
  'example.esp32-night-light.title': 'ESP32: RGB night light with a light sensor',
  'example.esp32-night-light.summary':
    'A light-sensor divider on GPIO34 read as a digital level (no ADC): dark (below about 3 lx) reads HIGH and the firmware lights all three RGB channels through GPIO4: white. Bright (above about 110 lx) reads LOW; in between the input keeps its last level. Change the light in the Properties panel while running. Runs on the ESP32 runtime service.',
  'example.esp32-distance-alarm.title': 'ESP32: ultrasonic distance alarm',
  'example.esp32-distance-alarm.summary':
    'An HC-SR04 measures the distance to a target: GPIO5 sends the 10 µs trigger pulse and the echo pulse returns to GPIO18 through a 1 kΩ / 2 kΩ divider (the module runs from 5 V). The sketch prints the distance (pulse width in µs / 58 = cm); closer than 20 cm, GPIO2 lights the red LED. Change the target distance in the Properties panel while running. Runs on the ESP32 runtime service.',
  'example.esp32-thermo-hygrometer.title': 'ESP32: temperature and humidity (DHT22)',
  'example.esp32-thermo-hygrometer.summary':
    'A DHT22 / AM2302 on GPIO4, with the 10 kΩ pull-up its single-wire data line needs, read by a short library-free routine that follows the datasheet timing. The serial output shows the temperature and relative humidity every 2.5 s. Change both in the Properties panel while running. Runs on the ESP32 runtime service.',
  'example.esp32-lcd-hello.title': 'ESP32: hello on a 16×2 I2C LCD',
  'example.esp32-lcd-hello.summary':
    'The sketch drives the LCD through its PCF8574 I2C backpack with plain Wire writes: line 1 says hello, line 2 counts the seconds. The module runs from 4.5 V so that the 3.3 V bus pull-ups (two 4.7 kΩ resistors to a second supply) read HIGH at its inputs (0.7 × 4.5 V = 3.15 V). Runs on the ESP32 runtime service.',
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
  // Sprint 13 H1: what runs on the ESP32 (packages/domain/src/capabilities.ts).
  'menu.capabilities': 'What runs on the ESP32',
  'capabilities.title': 'What runs on the ESP32 in TBI Lab',
  'capabilities.intro':
    'TBI Lab runs your sketch on an emulated Classic ESP32 (ESP32 DevKitC, WROOM-32) and simulates the circuit around it. This list says exactly what is simulated, what has limits, and what is refused. A refused feature never runs silently: the product tells you before Run.',
  'capabilities.close': 'Close',
  'capabilities.learnMore': 'What runs on the ESP32?',
  'capabilities.section.firmware': 'Firmware features',
  'capabilities.section.parts': 'Parts next to an ESP32',
  'capabilities.section.timing': 'Timing',
  'capabilities.section.limits': 'Shared service limits',
  'capabilities.status.supported': 'Supported',
  'capabilities.status.limited': 'Supported with limits',
  'capabilities.status.unsupported': 'Not supported',
  'capabilities.facility.digital_io.name': 'Digital input and output',
  'capabilities.facility.digital_io.body':
    'pinMode, digitalWrite and digitalRead on the pins the board diagram marks as available. Levels and currents come from the circuit simulation.',
  'capabilities.facility.serial.name': 'Serial monitor (UART0)',
  'capabilities.facility.serial.body':
    'Serial.print and Serial.read through the ESP32 terminal. The text is exact; the bit timing of the line is not simulated.',
  'capabilities.facility.preferences.name': 'Preferences (non-volatile storage)',
  'capabilities.facility.preferences.body':
    'The Preferences library works within one run. Nothing is kept after Stop.',
  'capabilities.facility.i2c.name': 'I2C bus (Wire)',
  'capabilities.facility.i2c.body':
    'Wire as controller on the supported I2C parts, with real addresses, acknowledgements and pull-up levels. The duration of each bus transfer is not simulated.',
  'capabilities.facility.timing.name': 'millis, micros, delay, delayMicroseconds, pulseIn',
  'capabilities.facility.timing.body':
    'Run in simulated time. See Timing below for the exact limits.',
  'capabilities.facility.dual_core.name': 'Both CPU cores (FreeRTOS tasks)',
  'capabilities.facility.dual_core.body':
    'Tasks run on both cores. A sketch that keeps core 0 busy can delay code on core 1 by up to about 1 ms, so microsecond timing is not supported in such sketches.',
  'capabilities.facility.pwm.name': 'PWM / LEDC output (analogWrite, ledcWrite)',
  'capabilities.facility.pwm.body':
    'Not simulated yet. A sketch that uses it is refused before Run.',
  'capabilities.facility.interrupt.name': 'GPIO interrupts (attachInterrupt)',
  'capabilities.facility.interrupt.body': 'Not simulated. Poll the pin with digitalRead instead.',
  'capabilities.facility.internal_pull.name':
    'Internal pull-up / pull-down (INPUT_PULLUP, INPUT_PULLDOWN)',
  'capabilities.facility.internal_pull.body':
    'Not simulated. Add an external resistor to the circuit.',
  'capabilities.facility.adc.name': 'Analog input (analogRead, ADC)',
  'capabilities.facility.adc.body':
    'Not simulated. Light and other sensors are read as digital levels.',
  'capabilities.facility.dac.name': 'Analog output (dacWrite)',
  'capabilities.facility.dac.body': 'Not simulated.',
  'capabilities.facility.touch.name': 'Touch sensing',
  'capabilities.facility.touch.body': 'Not simulated.',
  'capabilities.facility.spi.name': 'SPI bus',
  'capabilities.facility.spi.body': 'Not simulated.',
  'capabilities.facility.wifi.name': 'Wi-Fi networking',
  'capabilities.facility.wifi.body':
    'Not simulated. Sketches that use Wi-Fi are refused before Run.',
  'capabilities.facility.bluetooth.name': 'Bluetooth',
  'capabilities.facility.bluetooth.body': 'Not simulated.',
  'capabilities.facility.sleep.name': 'Sleep modes',
  'capabilities.facility.sleep.body': 'Not simulated.',
  'capabilities.facility.drive_strength.name': 'Pin drive strength (gpio_set_drive_capability)',
  'capabilities.facility.drive_strength.body':
    'Not simulated: pins use the default drive strength. Code that selects another strength is refused at Build.',
  'capabilities.facility.restart.name': 'Chip restart (ESP.restart)',
  'capabilities.facility.restart.body': 'Not simulated. Press Stop and Run to start again.',
  'capabilities.facility.library.name': 'Arduino libraries',
  'capabilities.facility.library.body':
    'Only libraries built into the ESP32 core that are listed here run (Preferences; Wire on the I2C parts). Other libraries, such as DHT or LiquidCrystal_I2C, are refused; the curated examples show the same parts without them.',
  'capabilities.timing.electrical_exact':
    'Signals the simulated parts send (for example a sensor echo) and the pin levels your sketch writes are placed at their exact simulated time.',
  'capabilities.timing.polling':
    'Your sketch sees an input change when it next reads the pin. In each simulated millisecond there are short intervals, up to about 13 µs, when the emulated core cannot run, so a change can be seen that much later.',
  'capabilities.timing.outputs_longer':
    'Pulses your sketch times with delayMicroseconds can come out up to about 12 µs longer, never shorter.',
  'capabilities.timing.busy_core0':
    'If a task keeps core 0 busy, code on core 1 can be delayed by up to about 1 ms. Microsecond timing is not supported in such sketches.',
  'capabilities.timing.delay_phase':
    'delay() keeps its length exactly; the first wake-up can come up to about 0.5 ms later than on a real board.',
  'capabilities.timing.pulsein':
    'pulseIn readings are within one microsecond of the true width; when an edge falls into one of the short intervals above, a reading can be off by up to about 13.5 µs (about 2 mm for an HC-SR04).',
  'capabilities.timing.no_us_claim':
    'TBI Lab does not claim unrestricted microsecond timing. If exact timing matters for your project, check it on a real board.',
  'capabilities.limit.runtime_busy':
    'The shared ESP32 simulator is at capacity. Your project is not affected; try Run again in a moment.',
  'capabilities.limit.session_quota':
    'Each person runs one ESP32 simulation at a time. Stop the other one first.',
  'capabilities.limit.rate_limited':
    'Too many runs were started in a short time. Wait the time shown, then try again.',
  'capabilities.limit.session_expired':
    'A run ends after 30 minutes or when the page stops responding. Press Run to start a new one.',
  'capabilities.limit.commands_rate_limited':
    'Part controls changed too quickly while running; some changes were refused. Change them more slowly.',
  'capabilities.parts.supported': 'Simulated with the ESP32.',
  // Sprint 13 H2: outside the specified operating range; damage threshold unknown (not "safe").
  'rating.operating.heading': 'Outside specified operating conditions',
  'rating.operating.summary': '{component} is outside its specified operating range',
  'rating.operating.row.voltage': 'Supply: {value} (specified operating maximum {limit})',
  'rating.operating.note':
    'Outside the recommended operating range but within the published absolute maximum: reliability and the simulated result are not guaranteed. Keep the part inside its operating range.',
  // Sprint 13 P2: a value from a pad beyond its characterized point is not a physical value.
  'rating.value.uncharacterized':
    'current not known (beyond the range the manufacturer characterizes)',
  'rating.unrated.summary':
    '{component} is outside its specified range; no damage threshold is published',
  'rating.unrated.note':
    'The manufacturer publishes no damage threshold for this condition: the risk is unknown, not zero. Treat it as unsafe; the simulated result may not match a real part.',
  'rating.row.gpio_input_overvoltage':
    "{pin} input is at {value}, outside the pin's specified input range (limit {limit}); ESP32 pins are not specified for 5 V",
  'rating.row.gpio_cumulative_current':
    'All ESP32 output pins together deliver {value} (absolute maximum {limit})',
  // Sprint 13 H2: model limitations (packages/domain/src/capabilities.ts MODEL_LIMITATIONS).
  'limitation.psu_ideal':
    'Ideal lab supply: no output impedance or control-loop dynamics, and it cannot sink current.',
  'limitation.resistor_ideal':
    'Exact value: tolerance and temperature coefficient are not modelled.',
  'limitation.resistor_no_power':
    'No power rating is modelled: dissipation is shown but not checked against a limit.',
  'limitation.dc_25c': 'DC operating point at 25 °C: no thermal or self-heating effects.',
  'limitation.led_card_range':
    'Accurate within the current range of its datasheet curves; outside it the result is marked as outside the model.',
  'limitation.no_breakdown':
    'Reverse breakdown is not modelled; the reverse-voltage rating is checked and warned about instead.',
  'limitation.switch_ideal': 'Ideal contact: no contact resistance or bounce.',
  'limitation.rgb_onoff_esp32':
    'Next to an ESP32 each channel is on or off: PWM colour mixing is not supported.',
  'limitation.ldr_typical':
    'A typical GL5528 (the centre of its resistance class), not a measured part.',
  'limitation.ldr_extrapolated':
    'Outside 1–100 lx the light law is extrapolated, and the result says so.',
  'limitation.ldr_digital_esp32':
    'Next to an ESP32 it is read as a digital level: analog input is not supported.',
  'limitation.ldr_no_dynamics': 'Response time and temperature dependence are not modelled.',
  'limitation.buzzer_curve':
    'Current follows the datasheet curve within 3–6 V; outside it the result is marked as outside the model.',
  'limitation.buzzer_dc':
    'An active buzzer on DC: whether it sounds is simulated, its tone and loudness are not.',
  'limitation.relay_thresholds':
    'Pull-in and drop-out use the guaranteed datasheet limits (3.75 V / 0.5 V), not a particular part.',
  'limitation.relay_no_inductance':
    'Coil inductance is not modelled, so the switch-off voltage spike is not simulated: use a flyback diode as on a real board.',
  'limitation.relay_ideal_contacts':
    'Ideal contacts: contact resistance, bounce and operate/release times are not modelled.',
  'limitation.bjt_dc':
    'DC transistor model at 25 °C: no capacitances, transit times or self-heating.',
  'limitation.bjt_no_breakdown':
    'Breakdown is not modelled; the voltage ratings are checked and warned about instead.',
  'limitation.pir_static':
    'Motion is a control you set. Retrigger delay, blocking time, the warm-up minute, range, angle and sensitivity are not modelled.',
  'limitation.matrix_window':
    'Each dot is solved from the circuit; a scanned display is shown as its last state in each 10 ms window (no persistence of vision).',
  'limitation.matrix_no_esp32': 'Not available next to an ESP32 yet.',
  'limitation.capacitor_ideal':
    'Ideal capacitor: no ESR, leakage, dielectric absorption or polarity.',
  'limitation.capacitor_no_esp32': 'Time-dependent parts run only in circuits without an ESP32.',
  'limitation.hcsr04_target':
    "One flat target at the set distance, in still air at the set temperature; outside the module's range there is no echo.",
  'limitation.hcsr04_output':
    'The ECHO output resistance (100 Ω) is an assumption: none of the sources specifies it.',
  'limitation.hcsr04_retrigger': 'A new trigger is ignored while an echo is pending.',
  'limitation.supply_below_min':
    'Below the minimum supply voltage the module is shown as switched off; a real module there may behave unpredictably, and the result is marked as outside the model.',
  'limitation.dht22_tgo':
    "The sensor's response delay is 30 µs, the middle of the datasheet's 20–40 µs.",
  'limitation.dht22_current':
    'The 1–1.5 mA measuring current (about 5 ms per reading) is not in the DC result.',
  'limitation.dht22_output':
    'The DATA low-level output resistance (100 Ω) is an assumption: the datasheets do not give it.',
  'limitation.lcd_backlight':
    'The backlight is modelled as its datasheet 20 mA: the backpack schematic was not found.',
  'limitation.lcd_bus_timing':
    'I2C is simulated per transfer: the duration of a transfer and the line levels during it are not simulated.',
  'limitation.lcd_pullups':
    'The module is modelled without on-board pull-ups: the circuit must provide them.',
  'limitation.esp32_timing': 'Timing follows the V1 timing contract (see What runs on the ESP32).',
  'limitation.esp32_pulls': 'Internal pull-up and pull-down resistors are not simulated.',
  'limitation.esp32_drive':
    "Every pin driver uses the datasheet's maximum-drive-strength characteristic (40 mA at 2.64 V); sketches run at the default, weaker drive strength, and the datasheet gives 20 mA for GPIO16 and GPIO17. Beyond that characteristic (an overloaded or shorted pin) the current is not known and is not shown as a value.",
  'limitation.lcd_input_clamp':
    "The backpack's input protection diodes are not modelled: SDA or SCL above the module's supply + 0.5 V is flagged (absolute maximum), and the current that would flow into the pin is not simulated.",
  'sim.part.current.sda': 'SDA input',
  'sim.part.current.scl': 'SCL input',
  'limitation.esp32_input_clamp':
    'Input protection diodes are not modelled: a pin outside its specified range is flagged, and the simulated current into it is not reliable.',
  'inspector.limitations': 'Model limitations',
  // Sprint 13 H4: first-run guide.
  'onboarding.heading': 'Getting started',
  'onboarding.intro':
    'TBI Lab simulates a Classic ESP32 and the circuit around it, here in your browser.',
  'onboarding.step1': 'Open an ESP32 example below, for example the distance alarm.',
  'onboarding.step2': 'In the Code tab, press Build. The first build can take about a minute.',
  'onboarding.step3':
    'Press Run. While it runs, select a part and change what it senses (distance, temperature, light, motion): the firmware and the circuit respond.',
  'onboarding.note':
    'Projects are saved in this browser only: use Export to keep a copy. The ESP32 simulator is shared by the alpha testers; if it is busy, try again in a moment.',
  'onboarding.dismiss': 'Got it',
  'onboarding.show': 'Show getting started',
  // Sprint 13 H7 (shown only when a deployment configures the form).
  'menu.feedback': 'Send feedback',
} as const;

export type MessageKey = keyof typeof en;
