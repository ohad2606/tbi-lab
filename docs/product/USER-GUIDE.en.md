# TBI Lab user guide (beginners)

Draft for owner review. This guide describes what TBI Lab does on this branch. It makes no claim that TBI Lab meets an accessibility standard; known limits are in the last section.

## What TBI Lab is

TBI Lab is an electronics lab in your browser. You build a circuit around a Classic ESP32 (ESP32 DevKitC, WROOM-32), write a program for it, and run it. The voltages, currents and timing come from a simulation. When something cannot be simulated honestly, TBI Lab refuses it and says why.

It works on a computer, in Chrome or Edge. Your projects are saved in your browser, on your device. Use **Export project** in the menu to keep a copy, and **Import project…** on the Projects screen to restore it.

## Getting around

1. The **Projects** screen lists your projects and the examples. Create a new project there, or open an example.
2. Inside a project, the tabs **Circuit** and **Code** switch between the drawing and the program.
3. Three views show the same circuit. Choose them with the view tabs:
   - **Circuit**: the drawing where you place and wire parts.
   - **Schematic**: the circuit as a standard schematic.
   - **3D**: the circuit as a 3D scene. Rotate, pan and zoom it with the mouse or the keyboard.
4. The **Menu** has export, **What runs on the ESP32** (what is supported, limited and refused), **Send feedback** and **Report a problem…**.
5. **Undo** and **Redo** are in the top bar (`Ctrl/Cmd + Z`, `Ctrl/Cmd + Y`).
6. Press `?` anywhere outside a text field to open the list of keyboard shortcuts.

## Adding and wiring parts

With the mouse:

1. In **Components**, choose a part, then click on the canvas to place it. `Esc` cancels placing.
2. Select a part to move it, and use the inspector to change its values. `R` rotates a selected part; `Delete` removes it.
3. To wire, click a terminal. Click another terminal, a junction or a wire to finish. Click empty space to add a bend. `Esc` cancels.
4. Wiring and editing are not possible while the simulation runs. Stop it first.

With the keyboard (wiring with the keyboard):

1. Use `Tab` to move focus to a part in the circuit view.
2. Press `W` to enter pin mode. The arrow keys move between the part's pins.
3. Press `Enter` on a pin to start a wire. The arrow keys or `Tab` and `Shift + Tab` move between possible targets: pins, junctions and points on wires, nearest first. The current target is outlined on the canvas (a dashed ring; a target wire gets a dashed outline) and the view moves so it stays visible. Each target is also read out by a screen reader.
4. Press `Enter` to connect, or `Esc` to cancel. Pressing `Esc` in pin mode returns to the part.
5. `[` and `]` select the previous or next wire. With a wire selected, `E` re-picks one of its ends (`1` or `2`, or the arrow keys, then `Enter`; then choose the new pin as above). `Delete` removes the selected wire.
6. Wiring is not possible while the simulation runs.

## Code

Open the **Code** tab. Choose the **Programming language**: **Arduino C++** or **MicroPython**. Switching never deletes code: each language keeps its own program in the project, and switching back restores it. An example that has a twin in the other language opens the twin's program. Otherwise a starter program opens, and a notice tells you so.

- **Build** builds the code. Run needs a current build: if the code changed since the last build, or the build failed, Run is blocked and says why.
- A MicroPython program is `main.py`; you can add more `.py` files.
- The editor is a plain text field. `Tab` inserts two spaces; `Esc` and then `Tab` moves focus out. `Ctrl + M` switches `Tab` between indenting and moving focus.
- Only the Arduino and MicroPython features listed in **What runs on the ESP32** work. Anything else is refused by name, at Build or when the program uses it. See the tester guide (`docs/alpha/TESTER-GUIDE.md`) for the list.

## Run

1. Press **Build**, then press **Run**. The status shows starting, then running. Press **Stop** to end it.
2. The serial monitor shows what the program prints. It shows output only; there is no serial input.
3. While running, select a part to see its values, and change environment values such as a distance. Toggle a focused switch with `Space`.
4. The simulator is shared. If it is busy, wait a moment and press Run again.

## Probes and warnings

- The **Probe** tool shows the voltage of a terminal or wire (to GND), or the current through a part. Press `Esc` to leave the tool. Probes only read values; they never change the circuit.
- A part pushed beyond its published absolute maximum is marked "may be damaged". Outside its specified operating range you get a separate notice. If the manufacturer publishes no damage threshold, the risk is unknown: treat it as unsafe. The simulation keeps showing the calculated values and does not model damage.
- Wrong wiring is explained, not hidden. For example, an ESP32 input that nothing holds at a level stops the run, and the message suggests a pull-up or pull-down resistor (for example 10 kΩ). The ESP32's internal pull resistors are not simulated.

## Examples

On the **Projects** screen, search the examples and choose **Open example**. Each example opens as a new project of your own, with its circuit already wired, so you can press Run. Many examples have the same circuit in Arduino C++ and in MicroPython (the MicroPython ones start with "MicroPython:").

## Keyboard shortcuts

This list is copied from the shortcuts registry in the app (`app/src/ui/shortcuts.ts`). Ctrl/Cmd means Ctrl or Cmd. Key names are written as on a keyboard. `F`, `R`, `W` and `Z` mean the key in that position, so they also work on a Hebrew layout. `Esc` steps back one level. Run, Stop and Build have no keyboard shortcut; use their buttons.

### Everywhere

- <!-- shortcut:undo -->`Ctrl/Cmd + Z`: Undo the last project change (Anywhere except text fields)
- <!-- shortcut:redo -->`Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y`: Redo the change you undid (Anywhere except text fields)
- <!-- shortcut:help -->`?`: Open this list of keyboard shortcuts (Not while typing in a field or the code editor)
- <!-- shortcut:cancelPlace -->`Esc`: Cancel placing a part (While a part from the palette is armed)

### Circuit view

- <!-- shortcut:pinMode -->`W`: Start wiring from the focused part: choose one of its pins (A part has focus; not while running)
- <!-- shortcut:wireSelect -->`]` or `[`: Select the previous or next wire; its ends are announced (Circuit view, not in pin mode)
- <!-- shortcut:wireRepick -->`E`: Re-pick one end of the selected wire (choose the end, then the new pin) (A wire is selected; not while running or read-only)
- <!-- shortcut:escStep -->`Esc`: Step back one level: probe mode, armed part, drawing mode, then clear the selection (Circuit view)
- <!-- shortcut:delete -->`Delete` or `Backspace`: Delete the selected parts, wires or junctions (Something is selected; not in a read-only example)
- <!-- shortcut:rotate -->`R`: Rotate the selected parts (Parts are selected; not read-only)
- <!-- shortcut:moveSelection -->`Arrow keys`: Move the selection one grid step (with Shift, five steps) (Something is selected; not read-only)
- <!-- shortcut:panView -->`Arrow keys`: Pan the view (with Shift, faster) (Nothing is selected, or the example is read-only)
- <!-- shortcut:zoomIn -->`+` or `=`: Zoom in (Circuit view)
- <!-- shortcut:zoomOut -->`-`: Zoom out (Circuit view)
- <!-- shortcut:fit -->`F`: Fit the whole circuit to the view (the key in the F position on any keyboard layout) (Circuit view)
- <!-- shortcut:toggleSwitch -->`Space`: Toggle the switch (A switch has focus; simulation running)

### Wiring with the keyboard

- <!-- shortcut:pinNext -->`Arrow Down` or `Arrow Right`: Next pin of the part (Pin mode)
- <!-- shortcut:pinPrev -->`Arrow Up` or `Arrow Left` or `Shift + Tab`: Previous pin of the part (Pin mode)
- <!-- shortcut:wireStart -->`Enter`: Start a wire from this pin (Pin mode)
- <!-- shortcut:repickEnd -->`1` or `2`: Choose which end of the wire to move: 1 is the first end, 2 the second; or switch ends with the arrow keys or Tab and Shift + Tab, and press Enter to choose (After E, while choosing the end)
- <!-- shortcut:targetCycle -->`Arrow keys` or `Tab`: Move between possible targets: pins, junctions and points on wires (Tab is kept inside on purpose) (While choosing where the wire ends)
- <!-- shortcut:wireConnect -->`Enter`: Connect the wire to the chosen target (While choosing where the wire ends)
- <!-- shortcut:wireCancel -->`Esc`: Cancel; focus returns to the part (during a re-pick it stays on the canvas) (Pin mode or wiring)

### Schematic view

- <!-- shortcut:schematicSelect -->`Enter` or `Space`: Select the symbol or module (A symbol has focus)
- <!-- shortcut:panSchematic -->`Arrow keys`: Move the view (not mirrored in Hebrew) (The drawing or one of its symbols has focus)
- <!-- shortcut:zoomSchematic -->`+` or `=` or `-`: Zoom in or out (The drawing or one of its symbols has focus)
- <!-- shortcut:fitSchematic -->`Home`: Fit the whole circuit to the view (The drawing or one of its symbols has focus)

Without dragging: the buttons next to zoom and fit move the view left, right, up and down.

### 3D view

- <!-- shortcut:rotate3d -->`Arrow Left` or `Arrow Right`: Rotate the view by 22.5 degrees (not mirrored in Hebrew) (3D view has focus)
- <!-- shortcut:pan3d -->`Shift + Arrow keys`: Pan the view (3D view has focus)
- <!-- shortcut:zoom3d -->`+` or `=` or `-`: Zoom in or out (3D view has focus)
- <!-- shortcut:reset3d -->`Home`: Reset the camera (3D view has focus)
- <!-- shortcut:toggle3d -->`Space` or `Enter`: Toggle a selected switch, or hold a push button (3D view; a switch or button is selected; simulation running)
- <!-- shortcut:layersClose -->`Esc`: Close the layers panel; focus returns to its button (Layers panel open)

### Tabs, menus and dialogs

- <!-- shortcut:tabsMove -->`Arrow Left` or `Arrow Right`: Previous or next view tab (follows the reading direction) (A view tab has focus)
- <!-- shortcut:menuOpen -->`Arrow Down`: Open the menu and focus its first item (The menu button has focus)
- <!-- shortcut:menuMove -->`Arrow Up` or `Arrow Down` or `Home` or `End`: Move between menu items (wraps around) (Menu open)
- <!-- shortcut:menuClose -->`Esc`: Close the menu; focus returns to its button (Menu open)
- <!-- shortcut:dialogClose -->`Esc`: Close the dialog; focus returns to where you were (A dialog is open)

### Code editor

- <!-- shortcut:editorTab -->`Tab`: Insert two spaces (Code editor; Tab mode is indent (the default); not read-only)
- <!-- shortcut:editorLeave -->`Esc`: Stop capturing Tab: the next Tab moves focus out of the editor (Code editor)
- <!-- shortcut:editorBack -->`Shift + Tab`: Always move focus out of the editor, backwards (Code editor)
- <!-- shortcut:editorMode -->`Ctrl + M`: Switch Tab between indent and move focus; remembered in this browser (Code editor (Ctrl only; Cmd does not work here))

## Known limits and getting help

- This guide makes no claim that TBI Lab meets an accessibility standard. The circuit drawing does not yet tell a screen reader how parts are connected (known limit A11Y-028 in the tester guide).
- Analog input (ADC), DAC, touch, SPI, Wi-Fi, Bluetooth, sleep modes and internal pull-ups are refused. There is no serial input. I²C is limited to bus 0 on GPIO21/22 at up to 100 kHz, write-only. Timing is not unrestricted microsecond timing. The full list is in **What runs on the ESP32**.
- Use **Report a problem…** in the menu, or write to support@tbi-tech.net.
