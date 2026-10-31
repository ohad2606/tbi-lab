#pragma once

// Start the LCD (16 columns, 2 rows, backlight on, cleared).
void displayBegin();

// Show two lines of text, each from its first column.
void displayShow(const char *line1, const char *line2);
