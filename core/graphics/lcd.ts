// Funcitons for setting and checking the LCD
import { Graphics } from './graphics';
// Assembly script really not feeling the reexport
import { eightBitLoadFromGBMemory } from '../memory/load';
import { eightBitStoreIntoGBMemory } from '../memory/store';
import { updateHblankHdma } from '../memory/index';
import { requestLcdInterrupt, requestVBlankInterrupt } from '../interrupts/index';
import { checkBitOnByte, setBitOnByte, resetBitOnByte } from '../helpers/index';
import { FRAME_LOCATION, FRAME_SIZE } from '../constants';

export class Lcd {
  // Memory Locations
  // Also known at STAT
  // LCD Status (0xFF41) bits Explanation
  // 0                0                    000                    0             00
  //       |Coicedence Interrupt|     |Mode Interrupts|  |coincidence flag|  | Mode |
  // Modes:
  // 0 or 00: H-Blank
  // 1 or 01: V-Blank
  // 2 or 10: Searching Sprites Atts
  // 3 or 11: Transfering Data to LCD Driver
  static readonly memoryLocationLcdStatus: i32 = 0xff41;
  static mode: i32 = 0;
  // Function called in write traps to update our hardware registers
  static updateLcdStatus(value: i32): void {
    // Bottom three bits are read only
    let currentLcdStatus: i32 = eightBitLoadFromGBMemory(Lcd.memoryLocationLcdStatus);
    let valueNoBottomBits = value & 0xf8;
    let lcdStatusOnlyBottomBits = currentLcdStatus & 0x07;
    value = valueNoBottomBits | lcdStatusOnlyBottomBits;

    // Top bit is always 1
    value = setBitOnByte(7, value);

    eightBitStoreIntoGBMemory(Lcd.memoryLocationLcdStatus, value);
  }

  static readonly memoryLocationCoincidenceCompare: i32 = 0xff45;
  static coincidenceCompare: i32 = 0;

  // Also known as LCDC
  // http://www.codeslinger.co.uk/pages/projects/gameboy/graphics.html
  // Bit 7 - LCD Display Enable (0=Off, 1=On)
  // Bit 6 - Window Tile Map Display Select (0=9800-9BFF, 1=9C00-9FFF)
  // Bit 5 - Window Display Enable (0=Off, 1=On)
  // Bit 4 - BG & Window Tile Data Select (0=8800-97FF, 1=8000-8FFF)
  // Bit 3 - BG Tile Map Display Select (0=9800-9BFF, 1=9C00-9FFF)
  // Bit 2 - OBJ (Sprite) Size (0=8x8, 1=8x16)
  // Bit 1 - OBJ (Sprite) Display Enable (0=Off, 1=On)
  // Bit 0 - BG Display (for CGB see below) (0=Off, 1=On
  static readonly memoryLocationLcdControl: i32 = 0xff40;
  // Decoupled LCDC for caching
  static enabled: boolean = true;
  static windowTileMapDisplaySelect: boolean = false;
  static windowDisplayEnabled: boolean = false;
  static bgWindowTileDataSelect: boolean = false;
  static bgTileMapDisplaySelect: boolean = false;
  static tallSpriteSize: boolean = false;
  static spriteDisplayEnable: boolean = false;
  static bgDisplayEnabled: boolean = false;

  // Function called in write traps to update our hardware registers
  static updateLcdControl(value: i32): void {
    let wasLcdEnabled = Lcd.enabled;

    Lcd.enabled = checkBitOnByte(7, value);
    Lcd.windowTileMapDisplaySelect = checkBitOnByte(6, value);
    Lcd.windowDisplayEnabled = checkBitOnByte(5, value);
    Lcd.bgWindowTileDataSelect = checkBitOnByte(4, value);
    Lcd.bgTileMapDisplaySelect = checkBitOnByte(3, value);
    Lcd.tallSpriteSize = checkBitOnByte(2, value);
    Lcd.spriteDisplayEnable = checkBitOnByte(1, value);
    Lcd.bgDisplayEnabled = checkBitOnByte(0, value);

    if (wasLcdEnabled && !Lcd.enabled) {
      // Disable the LCD
      resetLcd(true);
    }

    if (!wasLcdEnabled && Lcd.enabled) {
      // Re-enable the LCD
      resetLcd(false);
    }
  }

  // Cycle getters for scanlines
  // (NOTE: One scanline is 456 cycles. Thus, they should add to 456)
  // TODO: Optimize this, so that double speed updates all cycle constants
  // Rather than re-calculating every time

  // Hblank
  static MODE_0_CYCLES(): i32 {
    return 204 << (<i32>Cpu.GBCDoubleSpeed);
  }

  // OAM Search
  static MODE_2_CYCLES(): i32 {
    return 80 << (<i32>Cpu.GBCDoubleSpeed);
  }

  // Pixel Transfer
  static MODE_3_CYCLES(): i32 {
    return 172 << (<i32>Cpu.GBCDoubleSpeed);
  }

  static;
}

function resetLcd(shouldBlankScreen: boolean): void {
  // Reset scanline cycle counter
  Graphics.scanlineCycles = 0;
  Graphics.scanlineRegister = 0;
  eightBitStoreIntoGBMemory(Graphics.memoryLocationScanlineRegister, 0);

  // Set to mode 0
  // https://www.reddit.com/r/EmuDev/comments/4w6479/gb_dr_mario_level_generation_issues/
  let lcdStatus: i32 = eightBitLoadFromGBMemory(Lcd.memoryLocationLcdStatus);
  lcdStatus = resetBitOnByte(1, lcdStatus);
  lcdStatus = resetBitOnByte(0, lcdStatus);
  Lcd.mode = 0;

  // Store the status in memory
  eightBitStoreIntoGBMemory(Lcd.memoryLocationLcdStatus, lcdStatus);

  // Blank the screen
  if (shouldBlankScreen) {
    for (let i = 0; i < FRAME_SIZE; ++i) {
      store<u8>(FRAME_LOCATION + i, 255);
    }
  }
}

function checkCoincidence(lcdMode: i32, lcdStatus: i32): i32 {
  // Check for the coincidence flag
  // Need to check on every mode, and not just HBLANK, as checking on hblank breaks shantae, which checks on vblank
  if ((lcdMode === 0 || lcdMode === 1) && Graphics.scanlineRegister === Lcd.coincidenceCompare) {
    lcdStatus = setBitOnByte(2, lcdStatus);
    if (checkBitOnByte(6, lcdStatus)) {
      requestLcdInterrupt();
    }
  } else {
    lcdStatus = resetBitOnByte(2, lcdStatus);
  }

  return lcdStatus;
}

export function updateLcd(): void {
  // Get our current scanline, and lcd mode
  let scanlineRegister: i32 = Graphics.scanlineRegister;
  let scanlineCycles: i32 = Graphics.scanlineCycles;
  let lcdMode: i32 = Lcd.mode;

  // Get our new LCD mode (if it is new)
  let newLcdMode: i32 = 0;

  // First check if we are in V-Blank
  if (scanlineRegister >= 144) {
    // VBlank mode
    newLcdMode = 1;
  } else {
    // We are drawing scanlines
    // Get all of our cycles
    let mode2Cycles = Lcd.MODE_2_CYCLES();
    let mode3Cycles = Lcd.MODE_3_CYCLES();
    let mode0Cycles = Lcd.MODE_0_CYCLES();

    if (scanlineCycles > mode2Cycles + mode3Cycles) {
      // We are in mode 0 Hblank
      newLcdMode = 0;
    } else if (scanlineCycles > mode2Cycles) {
      // We are in mode 3 Pixel Transfer
      newLcdMode = 3;
    } else {
      // We are in mode 2, OAM Search
      newLcdMode = 2;
    }
  }

  if (lcdMode !== newLcdMode) {
    // Get our lcd status
    let lcdStatus: i32 = eightBitLoadFromGBMemory(Lcd.memoryLocationLcdStatus);

    // Save our lcd mode
    Lcd.mode = newLcdMode;

    let shouldRequestInterrupt = false;

    // Set our LCD Status accordingly
    switch (newLcdMode) {
      case 0x00:
        lcdStatus = resetBitOnByte(0, lcdStatus);
        lcdStatus = resetBitOnByte(1, lcdStatus);
        shouldRequestInterrupt = checkBitOnByte(3, lcdStatus);

        // Update the Hblank DMA, will simply return if not active
        updateHblankHdma();

        break;
      case 0x01:
        lcdStatus = resetBitOnByte(1, lcdStatus);
        lcdStatus = setBitOnByte(0, lcdStatus);
        shouldRequestInterrupt = checkBitOnByte(4, lcdStatus);

        // request a VBLANK interrupt
        requestVBlankInterrupt();

        break;
      case 0x02:
        lcdStatus = resetBitOnByte(0, lcdStatus);
        lcdStatus = setBitOnByte(1, lcdStatus);
        shouldRequestInterrupt = checkBitOnByte(5, lcdStatus);
        break;
      case 0x03:
        lcdStatus = setBitOnByte(0, lcdStatus);
        lcdStatus = setBitOnByte(1, lcdStatus);
        break;
    }

    // Check if we want to request an interrupt, and we JUST changed modes
    if (shouldRequestInterrupt) {
      requestLcdInterrupt();
    }

    // Check for the coincidence
    lcdStatus = checkCoincidence(newLcdMode, lcdStatus);

    // Finally, save our status
    eightBitStoreIntoGBMemory(Lcd.memoryLocationLcdStatus, lcdStatus);
  } else if (scanlineRegister === 153) {
    // Special Case, need to check LYC
    // Fix prehistorik man freeze
    let lcdStatus: i32 = eightBitLoadFromGBMemory(Lcd.memoryLocationLcdStatus);
    lcdStatus = checkCoincidence(newLcdMode, lcdStatus);
    eightBitStoreIntoGBMemory(Lcd.memoryLocationLcdStatus, lcdStatus);
  }
}
