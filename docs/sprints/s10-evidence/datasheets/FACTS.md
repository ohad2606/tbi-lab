# TBI Lab: primary-source datasheet facts

Fetch date for every file: **2026-10-06**. All files are in this directory. SHA-256 values are for the local file as downloaded.
"p." is the PDF page (printed page numbers match unless noted). **GRAPH READING** = I read the value off a plotted curve (rendered at 300–600 dpi). It is not a tabulated value; uncertainty is noted. **NOT FOUND** = the value is not in any source I could obtain. **CONFLICT** = the sources disagree.

Notes on how the files were fetched:
- onsemi.com refuses curl (Akamai "Access Denied"). The two onsemi PDFs were fetched with WebFetch, which saved the binary; I copied that file here. They are genuine PDFs (checked with `file` and `pdfinfo`).
- Mouser, MPJA and the Imperial College SG90 mirror refused or failed. I used other hosts, listed per part.

---

## 1. RGB LED, 5 mm, common cathode: Kingbright WP154A4SUREQBFZGC

| Item | Value |
|---|---|
| Source URL | https://www.kingbrightusa.com/images/catalog/spec/wp154a4sureqbfzgc.pdf (Kingbright USA, the manufacturer) |
| Local file | `wp154a4sureqbfzgc_kingbrightusa.pdf` (5 pages) |
| SHA-256 | `2433a90345da743a9b442d52146e2f0841fa1b8d68f11334e8ac6a92e47fdcbf` |
| Doc id / rev / date | Spec No: DSAJ8687 / 1101026910, Rev No: V.11A, Date: 03/25/2025 (page footer) |
| Common-cathode check | p.1 circuit diagram: pin 2 is the shared cathode of all three diodes. The part is **common cathode** (the "SUREQBFZGC" part number). I did not check the L-154A4SUREQBFZGEW. |

### Chip materials (p.1)
| Colour | Material |
|---|---|
| Hyper Red | AlGaInP on GaAs substrate |
| Blue | InGaN |
| Green | InGaN on sapphire |

### Optical / electrical at TA = 25 °C (p.2, "Electrical / Optical Characteristics")
| Parameter | Test | Red | Blue | Green | Page |
|---|---|---|---|---|---|
| λpeak (typ) | IF = 20 mA | 645 nm | 460 nm | 515 nm | 2 |
| λdom (typ) | IF = 20 mA | 630 nm | 465 nm | 525 nm | 2 |
| Δλ (spectral half-width, typ) | IF = 20 mA | 25 nm | 25 nm | 30 nm | 2 |
| VF typ | IF = 20 mA | 1.9 V | 3.3 V | 3.3 V | 2 |
| VF max | IF = 20 mA | 2.5 V | 4.0 V | 4.1 V | 2 |
| VF tolerance | | ±0.1 V (note 2) | | | 2 |
| IR max | VR = 5 V | 10 µA | 50 µA | 50 µA | 2 |
| TC of VF | IF = 20 mA, −10…85 °C | −1.9 mV/°C | −3.0 mV/°C | −3.0 mV/°C | 2 |
| TC of λpeak | | 0.14 nm/°C | 0.04 nm/°C | 0.05 nm/°C | 2 |
| TC of λdom | | 0.05 nm/°C | 0.03 nm/°C | 0.03 nm/°C | 2 |
| Iv min / typ @ 20 mA | | 650 / 1300 mcd (CIE127-2007: 200 / 400) | 400 / 900 mcd (CIE: 400 / 900) | 1900 / 3600 mcd (CIE: 1900 / 3600) | 1 |
| Viewing angle 2θ½ | | 50° | 50° | 50° | 1 |
| Lens | | Water clear | | | 1 |

### Absolute maximum ratings at TA = 25 °C (p.2)
| Parameter | Red | Blue | Green |
|---|---|---|---|
| Power dissipation PD | 75 mW | 120 mW | 102.5 mW |
| Reverse voltage VR | 5 V | 5 V | 5 V |
| DC forward current IF | 30 mA | 30 mA | 25 mA |
| Peak forward current IFP (1/10 duty, 0.1 ms) | 200 mA | 150 mA | 150 mA |
| Junction temperature Tj | 115 °C | 115 °C | 115 °C |
| ESD (HBM) | 3000 V | 250 V | 450 V |
| Rth J-A | 340 °C/W | 190 °C/W | 280 °C/W |
| Rth J-S | 270 °C/W | 110 °C/W | 220 °C/W |
| Operating / storage temperature | −40 to +85 °C | | |

Derating curves (p.3): the permissible IF stays flat to about 25 °C, then falls linearly to about 5–7 mA at 85 °C (GRAPH READING, approximate).

### I–V points (p.3, "Forward Current vs. Forward Voltage", Ta = 25 °C): GRAPH READING
Read from 600 dpi renders. Estimated uncertainty is about ±0.02 V (red) and ±0.03 V (blue/green).

| Colour | 5 mA | 10 mA | 20 mA | top of curve |
|---|---|---|---|---|
| Red | ≈1.81 V | ≈1.85 V | ≈1.90 V | 30 mA ≈ 1.93 V |
| Blue | ≈2.81 V | ≈3.00 V | ≈3.30 V | 30 mA ≈ 3.52 V |
| Green | ≈2.90 V | ≈3.00 V | ≈3.28 V | 25 mA ≈ 3.44 V |

Cross-check: the 20 mA readings agree with the tabulated VF typ (1.9 / 3.3 / 3.3 V).

### Pinout and package (p.1, "Package Dimensions"; units mm; tolerance ±0.25 unless noted)
| Item | Value |
|---|---|
| Pin 1 | Red anode |
| Pin 2 | **Common cathode**. Labelled "Cathode" and it is the **longest lead**. |
| Pin 3 | Blue anode |
| Pin 4 | Green anode |
| Lead lengths | Pin 2 is the longest: 24.5 (+3/−0) mm from the flange. Pin 3 is at least 2.5 mm shorter than pin 2. Pins 1 and 4 are at least 2.5 mm shorter than pin 3 (dims "2.5 Min."). |
| Lead pitch | **1.27 mm** between adjacent leads (not 2.54), measured where the leads leave the package |
| Lead cross-section | 0.5 mm square (+0.25/−0.1) |
| Lens diameter | Ø5.0 mm; flange Ø5.9 mm |
| Height (flange base to lens tip) | 8.6 mm; flange thickness 1.0 mm |
| Other | 1.0 Max (resin below the flange), 0.7 Max (meniscus) |
| Recommended PCB holes | 4 × Ø0.9 mm on a 1.27 mm pitch |

---

## 2. LDR: GL5528 CdS photocell

Two documents. Neither has a printed revision number.

| Item | Source A | Source B |
|---|---|---|
| Description | "CdS Photoconductive Cells GL5528" single sheet (no manufacturer name printed on it) | **Senba Optical & Electronic Co., Ltd.** "GL55 Series CdS Photoresistor Manual". This is the manufacturer document and the more authoritative one. |
| URL | https://cdn.sparkfun.com/datasheets/Sensors/LightImaging/SEN-09088.pdf (SparkFun-hosted) | https://www.electronicoscaldas.com/datasheet/GL55-Series_Senba-Optical-and-Electronic.pdf (distributor-hosted copy of the Senba PDF) |
| Local file | `gl5528_sparkfun.pdf` (1 page) | `gl55_senba_caldas.pdf` (5 pages) |
| SHA-256 | `568ea23f647b2c7b14daee99984244c5134cbc0d0ed63f4f424615c96d90384d` | `02b4172ef1791cfb0c967d4be7665ffc4505fc12b7d6972509d17bbe1aa301c8` |
| Date | PDF metadata 2007-04-25, "GL5528.xls" | not printed |

| Parameter | Source A (p.1) | Source B (Senba) | Page (B) |
|---|---|---|---|
| Light resistance @10 lux, 25 °C | 8–20 kΩ | 10–20 kΩ (row 2 of the Φ5 table) | 2 |
| Dark resistance | 1.0 MΩ min (measured 10 s after a 10 lux pulse) | 1 MΩ | 2 |
| Gamma γ(10→100 lux) = log(R10/R100) | **0.7** (tolerance ±0.1 per measuring-conditions note) | **0.6**. **CONFLICT** with A. | 2 |
| Max voltage (continuous, in dark) | 150 V | 150 V | 1 |
| Max power @25 °C | 100 mW | 100 mW | 1 |
| Spectral peak | 540 nm | 540 nm | 1 |
| Ambient temperature | −30…+70 °C | −30…+70 °C | 1 |
| Response time rise / decay | NOT FOUND | 20 ms / 30 ms | 2 |
| Light-resistance test condition | 10 lux, std light A 2854 K, after 2 h pre-illumination at 400–600 lux | same (2856 K) | 2 |
| Body diameter | Ø5.1 ± 0.2 mm | Ø5.1 ± 0.1 mm | 3 |
| Flat-to-flat (ceramic) | 4.3 ± 0.2 mm | 4.3 ± 0.2 mm | 3 |
| Body thickness | 2.4 mm max | 2.1 ± 0.2 mm | 3 |
| Lead spacing | **3.4 mm** | **3.0 ± 0.1 mm**. **CONFLICT** with A. | 3 |
| Lead diameter | Ø0.5 mm | Ø0.50 ± 0.05 mm | 3 |
| Overall length | 36 ± 2 mm | 34 ± 1 mm | 3 |
| Temperature behaviour | — | Relative resistance curve: about 75 % at −30 °C, 100 % at 20 °C, about 104 % at 50 °C (GRAPH READING, coarse) | 3 |

Caveat on source B: the response-time/gamma table on Senba p.2 does not print type names in its rows. It lists six light-resistance ranges for the "Φ5 series". I matched the 10–20 kΩ row to GL5528 because the type table on p.1 lists GL5528 second and the ranges agree. Treat this as an inference.

R(lux) curve (source A, p.1, log–log): band from about 50–100 kΩ at 1 lux to about 1.5–3 kΩ at 100 lux (GRAPH READING, coarse).

---

## 3. Active buzzer, 12 mm, 5 V, magnetic: CUI Devices / Same Sky CEM-1205-IC

| Item | Value |
|---|---|
| URL | https://www.sameskydevices.com/product/resource/cem-1205-ic.pdf (manufacturer; CUI Devices is now Same Sky) |
| Local file | `cem-1205-ic_samesky.pdf` (4 pages) |
| SHA-256 | `a4a26a0f7a0989d529c903c2c9943d7ae22faafe6a6d51da47a72313aeab3320` |
| Doc date | 09/11/2024 (page header). The revision-history table on p.4 is an image and I did not read it. |

| Parameter | Value | Page |
|---|---|---|
| Type | Magnetic buzzer indicator, internally driven, continuous tone | 1 |
| Rated voltage | 5.0 Vdc | 1 |
| Operating voltage | 3.0–6.0 Vdc | 1 |
| Current consumption | 30 mA max at rated voltage | 1 |
| Rated frequency | 2,400 Hz typ (2,250 min, 2,550 max) | 1 |
| SPL | 87 dBA min, 92 dBA typ at 10 cm, A-weighted, rated voltage | 1 |
| Coil resistance | NOT FOUND (not specified for this internally-driven part) | — |
| Dimensions | Ø12.0 × 9.5 mm (p.1); drawing (p.2): body Ø12.0, height 9.5. Pin-side dimensions "0.5", "4.5" and "3.5" are shown but not labelled; most likely the 4.5 mm pin length, though this is ambiguous. | 1–2 |
| Pin spacing | 7.6 mm | 2 |
| Pin diameter | 2 × Ø0.6 ± 0.1 mm; recommended PCB hole Ø0.8, pad Ø2.5 | 2 |
| Polarity marking | "+" marked on the top/side next to the positive pin ("Postive+" in the drawing); laser print "CEM1205IC" | 2 |
| Weight | 1.75 g | 1 |
| Temperature | −40 to +80 °C (operating and storage) | 1 |
| Seal | Washable; "remove seal after washing" | 1–2 |

Voltage vs. current (p.2, at 25 °C). GRAPH READING (300 dpi, ±0.5 mA): 3 V ≈ 13.3 mA; 4 V ≈ 22.5 mA; 5 V ≈ 27.6 mA; 6 V ≈ 30.0 mA.
Voltage vs. SPL (p.2). GRAPH READING (coarse, ±1 dB): 3 V ≈ 81 dB; 5 V ≈ 92 dB; 6 V ≈ 94 dB.

Note: this part is listed as current on the Same Sky site. The older CEM-1205C appears under "discontinued".

---

## 4. Relay: Songle SRD-05VDC-SL-C

| Item | Value |
|---|---|
| URL | https://www.circuitbasics.com/wp-content/uploads/2015/11/SRD-05VDC-SL-C-Datasheet.pdf. This is a third-party-hosted copy of the Songle "SONGLE RELAY / SRD" 2-page datasheet with the Songle logo. No manufacturer-hosted copy was reachable (songlerelay.com has no direct PDF link). |
| Local file | `srd05_circuitbasics.pdf` (2 pages) |
| SHA-256 | `9967e9a62db84c578fc8dc55f0d76fd95777a4c84ad1f2754477f43dac515e46` |
| Doc id/rev | None printed ("RELAY ISO9002 / SRD") |

Part-number decode (p.1, §3): SRD-**05VDC**-**S**(sealed)-**L**(coil sensitivity 0.36 W)-**C**(1 form C). So use the **"SRD (High Sensitivity)" 05 row**.

| Parameter | Value | Page |
|---|---|---|
| Nominal coil voltage | 5 VDC | 1 |
| Nominal coil current | 71.4 mA | 1 |
| Coil resistance | 70 Ω ±10 % (at 20 °C) | 1 |
| Coil power | about 0.36 W | 1 |
| Pull-in (must operate) | 75 % of nominal max → ≤ 3.75 V | 1 |
| Drop-out (must release) | 10 % of nominal min → ≥ 0.5 V | 1 |
| Max allowable coil voltage | 120 % of nominal → 6.0 V | 1 |
| (For comparison, the "D" 0.45 W standard version) | 89.3 mA, 55 Ω, 110 % max | 1 |
| Contact form | 1 form C (SPDT) | 1 |
| Contact rating, form C, resistive | 7 A 28 VDC; 10 A 125 VAC; 7 A 240 VAC | 2 |
| Contact rating, form C, inductive (cosΦ = 0.4, L/R = 7 ms) | 3 A 120 VAC; 3 A 28 VDC | 2 |
| Max allowable voltage | 250 VAC / 110 VDC | 2 |
| Max switching power (form C) | "800VAC/240W" as printed (probably 800 VA / 240 W) | 2 |
| Approval ratings | UL/CUL 10 A 125 VAC 28 VDC; TUV 10 A 240 VAC 28 VDC; CCC 7 A/240 VDC, 10 A/250 VDC (as printed) | 1 |
| Contact material | AgCdO | 2 |
| Contact resistance | 100 mΩ max (initial) | 2 |
| Operate time | 10 ms max | 2 |
| Release time | 5 ms max | 2 |
| Dielectric | coil–contact 1500 VAC 1 min; between contacts 1000 VAC 1 min | 2 |
| Insulation resistance | 100 MΩ min at 500 VDC | 2 |
| Life | mechanical 10^7 operations; electrical 10^5 operations | 2 |
| Ambient temperature | −25 to +70 °C | 2 |
| Weight | about 10 g | 2 |
| Dimensions | **19.1 max (L) × 15.5 max (W) × 15.3 max (H) mm**; pins protrude 5 mm (p.1 drawing) | 1 |
| Pins | coil/COM pins Ø0.6 (round, "2-Ø0.6"); contact pins 1 × 0.4 flat ("2-1×0.4"); 1.1 mm dimension on the contact pins | 1 |
| Drilling plan | COM pin is 1.4 mm from the body edge. Coil pin column is 2 ± 0.05 mm from COM. Contact column is 12.2 ± 0.05 mm from the coil column. Rows are 12 ± 0.05 mm apart, with COM on the centre line. **Not on a 2.54 mm grid.** | 1 |
| Wiring (p.1 wiring diagram) | Left side: two coil pins (top and bottom of the coil column); COM is the single pin offset 2 mm further left on the centre line. Right side: **NC is the bottom-right pin** (the COM arm rests on it) and **NO is the top-right pin**. | 1 |
| View direction of drilling/wiring drawings | **NOT STATED** in the datasheet. It is not labelled top or bottom view. |  |

Coil temperature rise vs. coil power, and operate/release time vs. coil power, are plotted on p.2. I did not read them.

---

## 5. NPN transistor 2N3904

### 5a. SPICE model: manufacturer-published (Fairchild, now onsemi)
| Item | Value |
|---|---|
| URL | https://www.farnell.com/datasheets/1849425.pdf. Distributor-hosted copy of the **Fairchild "2N3904 / MMBT3904 / PZT3904 NPN General Purpose Amplifier"** datasheet. |
| Local file | `2n3904_fairchild_farnell.pdf` (17 pages) |
| SHA-256 | `ab6a67a614b5ec2b5ada4cf0820a60ff08145a3ffda8381ae8283d659adb9091` |
| Doc id/rev | "©2001 Fairchild Semiconductor Corporation, 2N3904/MMBT3904/PZT3904, Rev A" |
| Location | p.2, box headed "Spice Model" |

Verbatim as printed (p.2):
```
NPN (Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734 Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2
Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p
Itf=.4 Vtf=4 Xtf=2 Rb=10)
```
**Typo in the printed datasheet:** it says `Ise=6.734` with no "f" suffix, which would mean 6.734 A. The same model in public PSpice/Fairchild library listings carries `Ise=6.734f` and the comment `* Fairchild pid=23 case=TO92`. For example, https://eelabs.faculty.unlv.edu/docs/labs/ee320L/ee320L_a2_models.txt prints:
```
.model Q2N3904   NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259
+                Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1
+                Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75
+                Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)
*                Fairchild        pid=23          case=TO92
```
Recommendation: use `Ise=6.734f` and record that this is a correction of an evident typo.

Parameters not listed take SPICE defaults: Nf = Nr = 1, Re = 0, Var = ∞, Rbm = Rb, Cjs = 0, Xcjc = 1, Ptf = 0.

**onsemi's own current SPICE download: NOT FOUND.** The onsemi model portal is rendered with JavaScript and onsemi blocks curl. The current onsemi 2N3904/D (Rev 3) does not print a model.

Other models found, not recommended:
- Diotec Semiconductor (manufacturer of a 2N3904) LTspice model: https://diotec.com/request/spice/2n3904.zip → `2n3904_diotec_spice.zip`, SHA-256 `81ab08bad728ad12c2cb080d78debb7dd8b7cbf3a2e79832285966b7e93c38ba`, dated 2017-12-13. It is a datasheet-parameter macro: `.model Transistor NPN(Is={Ices/2} Bf={hfe} ... )` with Ices = 50n, which gives **Is = 25 nA**. That is physically unrealistic for small-signal I–V, about 10^6× the Fairchild Is.
- Purdue course file https://www.physics.purdue.edu/~jones105/phys536_Spring2009/2N3904_model.txt has a different Gummel-Poon set (IS = 4.639E-15, BF = 160.1 …). Its origin is not stated, so it is not usable as a citation.

### 5b. Datasheet (onsemi)
| Item | Doc 1 | Doc 2 |
|---|---|---|
| Title | onsemi "General Purpose Transistors NPN Silicon 2N3903, 2N3904" (Motorola lineage) | onsemi "NPN General-Purpose Amplifier 2N3904" (Fairchild lineage) |
| URL | https://www.onsemi.com/pdf/datasheet/2n3903-d.pdf | https://www.onsemi.com/pdf/datasheet/2n3904-d.pdf |
| Local file | `2n3903-d_onsemi.pdf` (9 pages) | `2n3904-d_onsemi_fairchild.pdf` |
| SHA-256 | `254033368ac4a6ad14fde012ae3c27f8efe241024a5f1a9e550846db6cd73780` | `bfd37941cd4455e5d1426d1da4cbb27b047bde085fd1dd67b1c2be60a45914a1` |
| Doc id/rev | Publication Order Number 2N3903/D, August 2021 − Rev. 9 | 2N3904/D, October 2024 − Rev. 3 |

The values below are from Doc 1 (2N3903/D) p.1–2. Doc 2 p.1–2 gives the same values.

| Parameter | Value | Page |
|---|---|---|
| VCEO | 40 V | 1 |
| VCBO | 60 V | 1 |
| VEBO | 6.0 V | 1 |
| IC continuous | 200 mA | 1 |
| PD @ TA = 25 °C | 625 mW, derate 5.0 mW/°C | 1 |
| PD @ TC = 25 °C | 1.5 W, derate 12 mW/°C (Doc 1 only) | 1 |
| RθJA / RθJC | 200 / 83.3 °C/W | 1 |
| TJ, Tstg | −55 to +150 °C | 1 |
| hFE min (VCE = 1 V) | IC = 0.1 mA: 40; 1 mA: 70; 10 mA: 100 (max 300); 50 mA: 60; 100 mA: 30 | 2 |
| VCE(sat) max | 0.2 V @ IC = 10 mA, IB = 1 mA; 0.3 V @ 50 mA / 5 mA | 2 |
| VBE(sat) | 0.65 min / 0.85 max @ 10 mA / 1 mA; 0.95 max @ 50 mA / 5 mA | 2 |
| fT min | 300 MHz (IC = 10 mA, VCE = 20 V, f = 100 MHz) | 2 |
| Cobo / Cibo max | 4.0 pF / 8.0 pF | 2 |
| hfe (small-signal, 1 kHz, IC = 1 mA, VCE = 10 V) | 100–400 | 2 (Doc 1) |
| td / tr / ts / tf max | 35 / 35 / 200 / 50 ns | 2 |
| ICEX, IBL max | 50 nA (VCE = 30 V, VEB = 3 V) | 2 |

Text-extraction note: µA test currents (V(BR)CBO at 10 µA) appear as "mA" in the extracted text because of the symbol font. The rendered page shows µ.

**TO-92 pinout:** pin 1 = Emitter, pin 2 = Base, pin 3 = Collector (Doc 1 p.1 "TO-92 Case 29 Style 1"; Doc 2 p.1 "1: Emitter 2: Base 3: Collector"). The Case 29-11 drawing (Doc 1 p.7) shows the leads numbered 1-2-3 from the left when you face the flat side with the leads down. So the order facing the flat side is **E-B-C, left to right**. The Style-1 table is explicit text. The left-to-right orientation is my reading of the 3-D drawing on p.7.

**TO-92 (Case 29-11, Issue AM, document 98ASB42022B, 09 Mar 2007): straight-lead bulk pack (Doc 1 p.7)**, mm:
| Dim | Min | Max | Meaning |
|---|---|---|---|
| A | 4.45 | 5.20 | body width (across the flat face) |
| B | 4.32 | 5.33 | body height |
| C | 3.18 | 4.19 | body depth (flat to round back) |
| D | 0.407 | 0.533 | lead width |
| G | 1.15 | 1.39 | lead pitch (straight lead) |
| H | 2.42 | 2.66 | outer lead spacing |
| J | 0.39 | 0.50 | lead thickness |
| K | 12.70 | — | lead length |
| L | 6.35 | — | |
| N | 2.04 | 2.66 | |
| P | — | 2.54 | |
| R | 2.93 | — | |
| V | 3.43 | — | |

The bent-lead (tape and reel) version has G = 2.40–2.80 mm, which is the 2.54 mm-formed pitch.

Also downloaded: an ST (STMicroelectronics) 2N3904 datasheet, Feb 2003 (`2n3904_st_sparkfun.pdf`, https://www.sparkfun.com/datasheets/Components/2N3904.pdf, SHA-256 `dbdc35e85b16e85440f660366c88000042b3bf0ab215f57a2e5431e269040a52`). Its hFE minimums differ (60 / 80 / 100–300 / 60 / 30 at 0.1 / 1 / 10 / 50 / 100 mA) and it gives VCE(sat) of 0.2 V at 50 mA. Use onsemi values unless an ST part is modelled.

---

## 6. PIR module HC-SR501

**No single manufacturer.** "HC-SR501" is a generic Chinese module design built from a BISS0001 PIR controller, an LHI778 (or similar) pyroelectric sensor and a 7133-1 (HT7133-type) 3.3 V LDO. The widely copied English "datasheet" has no manufacturer name. The sources below are vendor/distributor documents and they **disagree** on several values.

| Item | Doc A (primary) | Doc B | Doc C |
|---|---|---|---|
| Title | "HC-SR501 PIR MOTION DETECTOR", 3 pages (the MPJA/alldatasheet document, with schematic) | Tayda Electronics "HC-SR501 PIR Motion Sensor" | Handson Technology "HC-SR501 User Guide" |
| URL | https://digsys.upc.edu/csd/chips/comp/HC_SR501.PDF (university mirror; PDF author tag "Provided by ALLDATASHEET.COM"). The original MPJA URL https://www.mpja.com/download/31227sc.pdf now returns 404. | https://www.taydaelectronics.com/datasheets/files/A-4432.pdf | http://www.handsontec.com/dataspecs/SR501%20Motion%20Sensor.pdf |
| Local | `hcsr501_upc.pdf` | `hcsr501_tayda.pdf` | `hcsr501_handsontec.pdf` |
| SHA-256 | `955d333a9ce2fdb821f9cf5eb0f857f4abfa0ce2949b98f4dd19164f9da2f86d` | `f0a610a7d02f979646e63fc8bff747f93da5983e023646ff557905491bad2ee3` | `7d353109616f19c96c7230de112682ec8b0cd82ae572c5a1dbba9208678ff934` |

Also downloaded: `hcsr501_electrokit.pdf` (https://www.electrokit.com/upload/quick/17/af/010a_41015509-ds.pdf, SHA-256 `a7c1f9bb47c181528b52d4ce550f792b7dd4953373173add43060cc128c940fd`). It repeats the Doc A p.1 text.

| Parameter | Value (Doc A unless noted) | Page | Conflicts |
|---|---|---|---|
| Supply voltage | DC 4.5–20 V (p.1 features, p.3 list) | 1, 3 | The p.1 spec list and p.3 table also say "5V–20V" / "5-20VDC". Doc B: 5–20 VDC. |
| Quiescent current | < 50 µA ("static current <50 microamps") | 1, 3 | **CONFLICT:** p.1 spec list says "Power Consumption: 65mA" (same in Doc C). This contradicts < 50 µA. |
| Output high / low | 3.3 V / 0 V | 1, 3 | |
| Output series resistor | **R14 = 1 kΩ** between BISS0001 pin 2 (OUT) and the module OUT pin (schematic) | 2 | Schematic only; no current rating given |
| Supply path | VIN → D1 → 7133-1 regulator (VOUT feeds BISS0001 VCC) | 2 | |
| Delay time | "5-300S (adjustable) Range (approximately .3Sec–5Min)"; potentiometer "5S" to "300S" | 1, 3 | Doc B: about 3 s to 5 min (text) and 5 s to 5 min (table). Doc C: 0.3–5 min. |
| Blocking time | 2.5 s default ("can be set 0.xx to tens of seconds") | 1, 3 | p.1 spec list: "Lock time: 0.2 sec". Doc B/C: about 3 s. **CONFLICT.** |
| Trigger modes | Jumper L = non-repeatable (single) trigger; H = repeatable trigger; "(Default repeated trigger)" | 1, 3 | |
| Detection range | 3 m (min setting) to 7 m (max), sensitivity potentiometer | 1 | |
| Detection angle | < 110° cone (p.3); "less than 120 degree" (p.1) | 1, 3 | |
| Warm-up | about 1 min after power-up; output may toggle 0–3 times | 1, 3 | |
| Operating temperature | −15 to +70 °C | 1, 3 | |
| Board dimensions | 32 × 24 mm | 1, 3 | Doc C: 32 × 23 mm |
| Mounting holes | 28 mm spacing, M2 screws | 1 | |
| Lens (Fresnel dome) diameter | 23 mm | 1, 3 | |
| Lens dome height | NOT FOUND | — | |
| Pin order | Photo (p.2), as labelled: GND, High/Low Output, +Power. Schematic connector: pin 1 = GND, pin 2 = OUT (via R14), pin 3 = VIN (via D1). | 2 | Pin order seen from the component side; the photo shows the PCB side without the dome |
| IC | BISS0001; trigger jumper JP1 selects BISS0001 pin 1 (A) to VCC (H) or GND (L) | 2–3 | |

---

## 7. Ultrasonic module HC-SR04

**No single manufacturer.** The usual reference is the Elecfreaks datasheet. Two more documents were used: Cytron (a distributor user's manual) and Manorshi (a module maker).

| Item | Doc A | Doc B | Doc C |
|---|---|---|---|
| Title | Elecfreaks "Ultrasonic Ranging Module HC-SR04" | Cytron "HC-SR04 User's Manual" | Manorshi "Ultrasonic Sensor Module HC-SR04" |
| URL | https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf (SparkFun-hosted) | https://cdn.awsli.com.br/945/945993/arquivos/HCSR04.pdf (third-party host) | https://rjrorwxhjiilll5q.ldycdn.com/HC-SR04-aidnoBpoKliRljSknpqollrj.pdf (manorshi.com CDN) |
| Local | `hcsr04_sparkfun.pdf` (3 pages) | `hcsr04_cytron.pdf` (8 pages) | `hcsr04_manorshi.pdf` (4 pages) |
| SHA-256 | `4ebdc3e1f70d84a1ca856d8fcd7f8b1f9e548a94e4012cd86d14ca0b30543b06` | `9782429ff5d2feddbd120d91fbc7db7d528fc957a6b95753b4e9e2f6a4cdc171` | `d65631832ac786d20584c61087abeefa866975080ad15507314b5c9bac9936a0` |

| Parameter | Doc A (Elecfreaks) | Others | Page (A) |
|---|---|---|---|
| Supply | DC 5 V | B: 4.5 / 5.0 / 5.5 V min/typ/max | 1–2 |
| Working current | 15 mA | B: 10 / 15 / 20 mA; quiescent 1.5 / 2 / 2.5 mA (< 2 mA). C: static < 5 mA. | 2 |
| Ultrasonic frequency | 40 kHz burst of 8 cycles | B: 40 kHz | 1–2 |
| "Working Frequency" | "40Hz" as printed (ambiguous; likely the max measurement rate) | | 2 |
| Trigger | ≥ 10 µs TTL high pulse | | 1–2 |
| Echo | high pulse; width proportional to range | | 2 |
| Range formula | µs / 58 = cm; µs / 148 = inch; range = high time × 340 m/s / 2 | C: same | 2 |
| Range | 2 cm – 4 m; accuracy "can reach 3 mm" | B: 2–400 cm, resolution 0.3 cm. C: 2–450 cm, accuracy 1 cm. | 1–2 |
| Measuring angle | 15° | B: "Effectual angle < 15°" and also "Measuring angle 30°". C: "no more than 30°". **CONFLICT.** | 2 |
| Measurement cycle | > 60 ms recommended | C: same | 2 |
| Dimensions | 45 × 20 × 15 mm | B: same | 2 |
| Pin order | Vcc, Trig, Echo, GND (left to right as drawn) | C: same | 2 |
| Transducer diameter | **NOT FOUND** in any of the three (Manorshi p.1 "Mechanical drawing" did not render; it is an image or empty). | | |
| Target requirement | ≥ 0.5 m², as flat as possible | | 2 |

---

## 8. DHT22 / AM2302 (Aosong), plus DHT11

| Item | Doc A | Doc B | Doc C (DHT11) |
|---|---|---|---|
| Title | "Digital relative humidity & temperature sensor AM2302/DHT22" (Aosong/MaxDetect sales sheet, contact Thomas Liu) | "DHT22 (also named AM2302)", Aosong Electronics Co., Ltd | "Digital relative humidity & temperature sensor DHT11", Aosong Electronics Co., Ltd (www.aosong.com) |
| URL | https://cdn-shop.adafruit.com/datasheets/Digital+humidity+and+temperature+sensor+AM2302.pdf (Adafruit-hosted) | https://cdn.sparkfun.com/assets/f/7/d/9/c/DHT22.pdf (SparkFun-hosted) | https://www.electronicoscaldas.com/datasheet/DHT11_Aosong.pdf (distributor-hosted) |
| Local | `am2302_adafruit.pdf` (5 pages) | `dht22_sparkfun.pdf` (10 pages) | `dht11_aosong_caldas.pdf` (6 pages) |
| SHA-256 | `e2827d9b41ae5e3d578580bc4f9c13865169a2ea6336f5a85d8d13d0279b2b43` | `c91441a385cdf58f5f0ae50b194f294d5d1f0faeaac9a010efacb7ecf21be448` | `a38c594dd7d55c17b04d3fed3fd9165b547b4543b00af7df663e6e391ab55d41` |
| Rev/date | none; PDF metadata 2013-07-25 | none | none |

### DHT22 / AM2302
| Parameter | Value | Source / page |
|---|---|---|
| Supply | 3.3–5.5 V DC (A p.1, p.2); 3.3–6 V (B p.2); electrical table 3.3 min / 5 typ / 6 max V (A p.5, B p.9) | A, B |
| Supply current | measuring 1–1.5 mA; standby 40–50 µA | A p.5, B p.9 |
| Humidity range / accuracy / resolution | 0–100 %RH; ±2 %RH (max ±5 %RH); 0.1 %RH | A p.1 |
| Temperature range / accuracy / resolution | −40…80 °C; ±0.5 °C; 0.1 °C | A p.1 |
| Repeatability | ±1 %RH; ±0.2 °C | A p.1 |
| Hysteresis / long-term drift | ±0.3 %RH; ±0.5 %RH/year | A p.1 |
| Sampling (collecting) period | 2 s; "interval of whole process must beyond 2 seconds"; B: "should be > 2 second" | A p.3, p.5; B p.9 |
| Power-up | do not send instructions for 1 s after power-up; 100 nF VDD–GND optional | A p.2 |
| Start signal | host pulls low "at least 1~10ms" (A p.4 text); figure "1ms minimum" (A p.4); B: "at least 1ms" | A p.4, B p.6 |
| Host release | host pulls up, waits 20–40 µs | A p.4 |
| Response | sensor low 80 µs, then high 80 µs | A p.4 |
| Bit framing | each bit starts with 50 µs low; then high **26–28 µs = "0"**, **70 µs = "1"** | A p.4 (figures), B p.8 |
| Frame | 40 bits, MSB first = 16-bit RH + 16-bit T + 8-bit checksum. RH = value / 10 %RH; T = value / 10 °C, with bit 15 of T = sign (1 = negative). Checksum = low 8 bits of the sum of the four data bytes. | A p.3 (worked example: 0x028C → 65.2 %RH, 0x015F → 35.1 °C, checksum 0xEE) |
| Frame (Doc B wording) | "8 bit integral RH + 8 bit decimal RH + 8 bit integral T + 8 bit decimal T + 8 bit check-sum". This wording is inconsistent with Doc A's 16-bit/10 encoding; Doc A has a worked example and is the one to follow. | B p.5 |
| One transaction | about 5 ms | B p.5 |
| Pull-up | 1 kΩ to VDD on DATA in the connection diagram (A p.2) | A p.2 |
| Dimensions (standard 4-pin) | 15.1 (W) × 25.1 (H) × 7.7 (D) mm; grille area 20.00 mm tall; pin pitch 2.54 mm; pin length 8.5 mm; 0.5 mm pins; 3 mm (hole/top feature) | A p.2 drawing |
| Dimensions (B text) | "small size 14*18*5.5mm; big size 22*28*5mm". **CONFLICT** with A's drawing. | B p.2 |
| Wired "big case" | 26.7 × 58.8 (53.4 body) × 13.8 mm, Ø4.1 hole; red = VCC, black = GND, yellow = DATA | A p.2 |
| Pin order (front, left to right) | 1 VDD, 2 DATA, 3 **GND** (A) / **NULL / NC** (B), 4 GND | A p.2; B p.4–5. **CONFLICT** on pin 3. |

### DHT11 (for comparison, Doc C)
| Parameter | Value | Page |
|---|---|---|
| Supply | 3.3–5.5 V DC; table 3.3 / 5 / 6 V | 1, 4 |
| Current | 1–1.5 mA measuring; 40–50 µA standby | 4 |
| Range | 20–90 %RH; 0–50 °C | 1 |
| Accuracy | ±5 %RH; ±2 °C | 1 |
| Resolution | 1 %RH; 1 °C | 1 |
| Sensing element | polymer humidity **resistor** (DHT22 uses a capacitor) | 1 |
| Frame | same 40-bit layout. Bytes = RH integer, RH decimal (always 0), T integer, T decimal (always 0), checksum. Example 0x21 00 1A 00 3B → 33 %RH, 26 °C. | 2 |
| Start signal | text: low "at least 1~10ms"; **figure: "Host pulls low 18ms minimum"**. **CONFLICT** within the document. | 3 |
| Response / bit timing | 80 µs low + 80 µs high; 50 µs low per bit; 26–28 µs = 0, 70 µs = 1 | 3–4 |
| Period | 2 s | 3–4 |
| Dimensions | 12 × 15.5 × 5.5 mm; pitch 2.54 mm; leads 8 mm | 2 |
| Pins (front, left to right) | 1 VDD, 2 DATA, 3 (not labelled in the drawing), 4 GND; diagram shows 1 kΩ pull-up | 2 |

---

## 9. Micro servo TowerPro SG90

**There is no formal manufacturer PDF datasheet.** The manufacturer's (TowerPro) product web page is the most authoritative source. The widely circulated "SG90 datasheet" is an unattributed page. The documents **disagree**.

| Item | Doc A (manufacturer) | Doc B | Doc C |
|---|---|---|---|
| Title | TowerPro product page "SG90 Digital" | "SG90 9 g Micro Servo" one-pager (the classic sheet) bundled in a 7-page web compilation | Handson Technology "SG90 TowerPro Micro Servo Motor User Guide" |
| URL | https://www.towerpro.com.tw/product/sg90-7/ | https://www.friendlywire.com/projects/ne555-servo-safe/SG90-datasheet.pdf (third-party). The Imperial College mirror (ee.ic.ac.uk) refused connections. | https://handsontec.com/dataspecs/motor_fan/SG90-Servo.pdf |
| Local | `sg90_towerpro_page.html` | `sg90_compilation_friendlywire.pdf` | `sg90_handsontec.pdf` (6 pages, 2018) |
| SHA-256 | `cad869d61313e2e39ae4d1e47977108c270898fe266fac665a529ccbac260075` (HTML as fetched) | `10c9ef2831f9d1a00fa9d5a436372e19a41c80be36e17938af204341f07accc3` | `7ac9770130ab9dd38ad573197ca802e0d0213be02ee3de7250041896b370bb7d` |

| Parameter | Doc A TowerPro | Doc B classic sheet (p.1) | Doc C Handsontec | Notes |
|---|---|---|---|---|
| Weight | 9 g | 9 g | 9.0 g (p.1); "14.7 g" in the p.2 table | |
| Dimensions | "23×12.2x29mm"; config table A = 30.3, B = 22.7, C = 27, D = 12.2, E = 32.3, F = 17 mm | **22.2 × 11.8 × 31 mm approx.** Drawing: body 22.2 long, 11.8 wide, 32.2 across the mounting flange, 31 overall height (to top of the horn hub), 16 mm from the bottom to the underside of the flange | 23.0 × 12.2 × 29.0 mm (p.1); p.2 table A = 32, B = 23, C = 28.5, D = 12, E = 32, F = 19.5 | **CONFLICT** |
| Stall torque | 1.8 kg·cm @ 4.8 V | 1.8 kgf·cm | 1.80 kg·cm @ 4.8 V (p.1); p.2 table 2.5 | |
| Speed | 0.1 s/60° @ 4.8 V | 0.1 s/60° | 0.12 s/60° (p.1); 0.1 (p.2) | |
| Operating voltage | 4.8 V; admin reply: "4.8V – 6V are fine" | 4.8 V (~5 V) | 4.8–6 V | |
| Operating current | admin reply: "about 0.5A – 2A" | — | — | Forum reply on the manufacturer page, not a specification |
| Dead band | **1 µs** | **10 µs** | — | **CONFLICT** |
| Temperature | 0–55 °C | 0–55 °C | — | |
| PWM period | NOT FOUND on the TowerPro page | — (the compilation p.2 says "Pulse Cycle: ca. 20 ms") | 20 ms (50 Hz) (p.2 figure) | |
| Pulse vs. angle | NOT FOUND. TowerPro admin reply to "1ms-2ms ... 180 degree?": **"all of our normal servos are operating 0-150 degrees unless specify 180 or 360 degrees."** | "Position "0" (1.5 ms pulse) is middle, "90" (~2ms pulse) is all the way to the left ... "-90" (~1ms pulse) is all the way to the left" (garbled as printed) | p.1: "Pulse Width: 500-2400 µs"; p.2: 1–2 ms "duty cycle"; "Position "0" (1.5ms) middle, "90" (~2ms) ... right, "-90" (~1ms) left" | **CONFLICT / ambiguous.** No source gives a clean, unambiguous pulse-to-angle map. |
| Rotation range | 0–150° (manufacturer reply) | "approximately 180 degrees (90 in each direction)" | 180° | **CONFLICT** |
| Wire colours | — | (compilation p.2, other vendor text) Red = Battery(+), Brown = Battery(−), Orange = Signal | p.2: PWM = Orange, Vcc = Red (+), Ground = Brown (−); connector order Ground, +V, Signal | consistent |
| Connector | JR (fits JR and Futaba); wire length 25 cm | — | JR | |
| Gear | POM gear set | — | plastic, 3-pole motor | |

Modelling recommendation: treat the pulse range and the angle span as **assumptions** and flag them. The defensible set is 1.0–2.0 ms for ±90° nominal (Doc B/C text) at a 20 ms period (Doc C). The manufacturer reply says the true travel is about 150°.

---

## 10. I2C 16×2 LCD: PCF8574 backpack + HD44780

### 10a. PCF8574 / PCF8574A
| Item | NXP | TI |
|---|---|---|
| URL | https://www.nxp.com/docs/en/data-sheet/PCF8574_PCF8574A.pdf (fetched via WebFetch) | https://www.ti.com/lit/ds/symlink/pcf8574.pdf |
| Local | `pcf8574_nxp.pdf` (33 pages) | `pcf8574_ti.pdf` (39 pages) |
| SHA-256 | `15873fa13e8b9e3baeb924cc5ce845eabf0e1d2671a441feaaa3c4bb56e77013` | `568d3b92d8129988bc39475fe17408d93466f777b4047e403d605184f61dba19` |
| Rev | Product data sheet Rev. 5, 27 May 2013 | SCPS068K, July 2001, revised September 2024 |

| Fact | Value | Source |
|---|---|---|
| PCF8574 7-bit address | 0100 A2 A1 A0 → **0x20–0x27** (write bytes 40h–4Eh) | NXP p.5 Fig 6 + Table 4; TI p.13 |
| PCF8574A 7-bit address | 0111 A2 A1 A0 → **0x38–0x3F** (write bytes 70h–7Eh) | NXP p.5–6 Table 5 |
| Address pins | no internal pull-ups; must be tied high or low | NXP p.5 |
| I/O type | 8 quasi-bidirectional ports; no direction register | NXP p.6 §8.1 |
| Weak pull-up | "weak 100 µA" current source (text); IOH 30 min … 300 max µA at VOH = VSS (table) | NXP p.6, p.16 |
| Accelerator pull-up | strong pull-up only during the HIGH time of the acknowledge clock; Itrt(pu) about 1 mA typ (VDD = 2.5 V) | NXP p.7, p.16 |
| Sink | IOL 10 min / 25 typ mA at VOL = 1 V, VDD = 5 V; total package 80 mA | NXP p.16, p.1 |
| Power-on state | all I/Os high (weak current source) | NXP p.6, p.16 note |
| Supply | 2.5–6 V; IDD 40 typ / 100 max µA at 100 kHz; standby 2.5 typ / 10 max µA | NXP p.16 |
| Bus speed | 100 kHz | NXP p.1 |
| INT | open-drain, IOL ≥ 1.6 mA at 0.4 V | NXP p.16 |

### 10b. Backpack bit mapping
The PCF8574 datasheets do **not** document the backpack mapping, because it is a board-level convention. Documented source used: the reference Arduino library **LiquidCrystal_I2C** (header comment "//YWROBOT", for the YwRobot backpack).
- URL: https://github.com/johnrickman/LiquidCrystal_I2C (files `LiquidCrystal_I2C.h`, `LiquidCrystal_I2C.cpp`; last commit touching the header `6aa5b8b47a75a11a04f380c2526c4a9d271d6c63`, 2018-01-25)
- Local: `LiquidCrystal_I2C.h` (SHA-256 `cff602ee6ac7404acf8eab99ca621a8e0ee641a219cfd87ec877cf03eb973a6f`), `LiquidCrystal_I2C.cpp` (SHA-256 `d777dcd59a66951254658017d1135b6f8e571c2bcf6e3b7d4042582da6280006`)

| PCF8574 bit | LCD signal | Evidence |
|---|---|---|
| P0 | RS | `#define Rs B00000001` (h:53) |
| P1 | R/W | `#define Rw B00000010` (h:52) |
| P2 | E | `#define En B00000100` (h:51) |
| P3 | Backlight (1 = on) | `#define LCD_BACKLIGHT 0x08` (h:48) |
| P4–P7 | D4–D7 | `send()` writes `value & 0xF0` then `(value<<4) & 0xF0` (cpp:256–259) |

Library timings: E pulse high ≥ 1 µs ("must be >450ns"), 50 µs after each nibble, 2000 µs after clear/home (cpp:134–140, 274–278).
**The backpack schematic itself: NOT FOUND** (no manufacturer schematic obtained). The mapping is an assumption that matches the most common board.

### 10c. HD44780U (Hitachi)
| Item | Value |
|---|---|
| URL | https://www.sparkfun.com/datasheets/LCD/HD44780.pdf (SparkFun-hosted copy of the Hitachi datasheet) |
| Local | `hd44780_sparkfun.pdf` |
| SHA-256 | `4324d67ec14fc8e7ba8cf7db7256749c9b80b94b3f8bedfa614a0d2839c7dea9` |
| Doc id/rev | ADE-207-272(Z), Rev. 0.0 (p.1) |

| Fact | Value | Page |
|---|---|---|
| Clear display | 0000 0001. Writes 20H to all DDRAM, AC = 0, sets I/D = 1. **No execution time is printed for Clear display in Table 6.** | 24 |
| Return home | 0000 001x, **1.52 ms** max (fosc = 270 kHz). The 1.52 ms figure belongs to Return home. | 24 |
| Entry mode set | 0000 01 I/D S, 37 µs | 24 |
| Display on/off | 0000 1 D C B, 37 µs | 24 |
| Cursor/display shift | 0001 S/C R/L xx, 37 µs | 24 |
| Function set | 001 DL N F xx; DL = 1 is 8-bit, N = 1 is 2 lines, F = 1 is 5×10 dots; 37 µs | 24–25 |
| Set CGRAM address | 01 AAAAAA, 37 µs | 24 |
| Set DDRAM address | 1 AAAAAAA, 37 µs | 24 |
| Read BF & AC | 0 µs | 24 |
| Write / read data | 37 µs (+ tADD 4 µs) | 25 |
| Time scaling | times scale with fosc (37 µs × 270/250 = 40 µs at 250 kHz) | 25 |
| DDRAM 2-line map | line 1 = 00H–27H, **line 2 = 40H–67H** | 29 |
| 4-bit init (Fig. 24) | Power on. Wait > 15 ms after VCC rises to 4.5 V (> 40 ms after 2.7 V). Send 0011 (8-bit function set), wait > 4.1 ms. 0011, wait > 100 µs. 0011. 0010 (switch to 4-bit). Then 0010 NF** (function set; N and F fixed after this). Then 0000 1000 (display off). Then 0000 0001 (clear). Then 0000 01 I/D S (entry mode). BF cannot be checked before the 4th step. | 46 |
| Character ROMs | A00 = Japanese standard font (HD44780UA00); A02 = European standard font | 2, 17 |

### 10d. 16×2 LCD module (JHD, on arduino.cc)
| Item | Value |
|---|---|
| URL | https://www.arduino.cc/documents/datasheets/LCDscreen.PDF (arduino.cc-hosted copy of the JHD manufacturer specification) |
| Local | `lcd1602_arduinocc.pdf` (21 pages) |
| SHA-256 | `5a324c3531a390fd93bd38aa9c5d369889ac80fe568b1171ad76b507fcf45170` |
| Doc | 晶汉达 JHD "Specification of LCD Module", model JHD659, part JHD659 M10 1.1, revision 1.1, 10/31/07 |

| Fact | Value | Page |
|---|---|---|
| Format | 16 characters × 2 lines, 5×7 (+cursor) dots, STN Y/G, controller SPLC780D or equivalent | 5 |
| Module (PCB) | **80.0 × 36.0 mm**, thickness 13.5 mm max | 5, 15 |
| Viewing area | **64.5 × 14.5 mm** | 5, 15 |
| Active area | 57.70 × 9.40 mm | 15 |
| Bezel | 70.70 × 23.80 mm | 15 |
| Character size / pitch | 2.95 × 4.35 mm / 3.65 × 5.05 mm | 5 |
| Dot size / pitch | 0.55 × 0.50 / 0.60 × 0.55 mm | 5 |
| Mounting holes | 4 × Ø2.9 (pad Ø3.5), on a 75.0 × 31.0 mm grid | 15 |
| Connector | 16 pins, 2.54 mm pitch (2.54 × 15 = 38.1 mm); pin 1 is 8.00 mm from the PCB edge; holes Ø1.0 | 15 |
| Pinout | 1 VSS, 2 VDD, 3 V0, 4 RS, 5 R/W, 6 E, 7–14 DB0–DB7, 15 LEDA, 16 LEDK | 15 |

The I2C backpack's own dimensions: NOT FOUND.

---

## 11. 8×8 LED matrix: 1088AS (3 mm dots, 32 × 32 mm)

| Item | Value |
|---|---|
| URL | https://cdn.velleman.eu/downloads/29/infosheets/vmp502_led8x8_1088as.pdf (Velleman distributor info sheet; names the manufacturer as **OASIS**) |
| Local | `1088as_velleman.pdf` (1 page) |
| SHA-256 | `25a14d7aa40f1d96514846b487d4e2932dad582e9b272cf27fd20a6ff5f4cdad` |
| Rev/date | none |

| Parameter | Value |
|---|---|
| Type | **Row cathode, column anode.** Each dot's anode goes to a column line and its cathode to a row line (schematic and text). |
| Colour / face | Red / black face |
| Wavelength | 625–630 nm |
| VF | 2.1–2.5 V (test current not stated) |
| IF | 20 mA (stated as "Forward Current"; not stated whether this is test or max) |
| Dimensions | 32 × 32 × 8.0 mm |
| Column (anode) pins, COL 1→8 | 13, 3, 4, 10, 6, 11, 15, 16 |
| Row (cathode) pins, ROW 1→8 | 9, 14, 8, 12, 1, 7, 2, 5 |
| Dot diameter | "3mm" (title) |
| Pin pitch / row spacing / pin-1 location / which face is row 1 | **NOT FOUND** (no mechanical drawing) |
| Absolute maximum IF, peak current, reverse voltage, power | **NOT FOUND** |

The pin numbers were read from a low-resolution schematic image. COL 2 = "3" was confirmed at 400 dpi.

Kingbright alternative: the Kingbright 1.2-inch (30 mm, 3 mm dot) TA12-11/TC12-11 family is **5×7**, not 8×8. I found no Kingbright 32 mm 8×8 single-colour part; this was not pursued further.

---

## Summary of NOT FOUND / CONFLICT items
- LED: none missing.
- LDR: gamma 0.7 (generic sheet) vs 0.6 (Senba); lead spacing 3.4 vs 3.0 mm. Response time is only in Senba, and is matched to GL5528 by row order.
- Buzzer: coil resistance not specified (internally driven part).
- Relay: the datasheet does not say whether the drilling/wiring view is from the top or the bottom.
- 2N3904: the printed Fairchild model has an `Ise` typo; onsemi's current downloadable model was not retrieved.
- HC-SR501: quiescent current (<50 µA vs "65 mA"), blocking time (2.5 s vs 0.2 s vs about 3 s) and delay range conflict across documents; lens dome height NOT FOUND.
- HC-SR04: transducer diameter NOT FOUND; measuring angle 15° vs 30°.
- DHT22: pin 3 is GND (AM2302 sheet) vs NC (DHT22 sheet); package dimensions conflict; DHT11 start-pulse text says 1–10 ms but its figure says 18 ms.
- SG90: no manufacturer pulse-to-angle specification; dead band 1 µs vs 10 µs; dimensions and travel conflict.
- PCF8574 backpack schematic: NOT FOUND. The mapping comes from library source code.
- 1088AS: mechanical drawing, pin pitch and absolute maximum ratings NOT FOUND.
