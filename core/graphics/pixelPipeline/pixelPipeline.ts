// Implementation of the pixel pipeline
// https://youtu.be/HyzD8pNlpwI?t=2957
import { log } from '../../helpers/index';
import { eightBitLoadFromGBMemory } from '../../memory/index';
import { Cpu } from '../../cpu/index';
import { Graphics } from '../graphics';
import { Lcd } from '../lcd';
import { Sprites } from '../sprites';
import { PixelFetcher } from './pixelFetcher';
import { PixelFifo } from './pixelFifo';

export class PixelPipeline {
  // Current cycle of the Pixel Pipeline
  // Ultimate Gameboy talk:
  // CPU is 1MHz (1 cycle = 4 cycles to us)
  // But Fifo is 4MHz and Fetcher is 2MHz on their talk.
  // Meaning the Fifo is 4 times as fast as CPU, and Fetcher is 2 times as fast.
  // In our case, we will use a base of 2Mhz, meaning on every cpu cycle,
  // We will update the fifo, and increase our Cycles By one.
  // When Cycles == 1, we will step the fetcher.
  static cycles: i32 = 0;

  // The X index of the previous sprite that was fetched
  static previousSpriteIndex: i32 = -1;

  // The last recorded scrollX value
  // Useful for checking background pixels
  static previousScrollX: i32 = 0;

  // Function to return the camera index we are currently rendering
  static getCurrentIndex(): i32 {
    return PixelFifo.currentIndex;
  }

  // Function to update/run the pixel pipeline
  static update(numberOfCycles: i32): void {
    // NOTE: Camera is reffering to what you can see inside the 160x144 viewport of the entire rendered 256x256 map.

    // Need to specify CPU vs PixelPipeline Cycles (see static declaration above).
    // In double speed mode, the realtive PixelPipleine cycles would be would be half.
    let cpuCycles: i32 = numberOfCycles;
    cpuCycles = cpuCycles >> (<i32>Cpu.GBCDoubleSpeed);

    for (let pixelPipelineCyclesStepped: i32 = 0; pixelPipelineCyclesStepped < cpuCycles; pixelPipelineCyclesStepped++) {
      // Push our a pixel
      PixelFifo.step();

      // Determine what we should be fetching
      // Call our fetching functions in order of their priority
      if (_tryToFetchSprite()) {
        // We are fetching a sprite!
        PixelFifo.startSpriteIdle();
      } else if (!isFetchingSprite()) {
        PixelFifo.stopSpriteIdle();

        if (_tryToFetchWindow()) {
          // We are fetching window!
        } else {
          _tryToFetchBackground();
        }
      }

      // Step our fetcher (2 times as slow as fifo)
      if (PixelPipeline.cycles !== 0) {
        PixelFetcher.step();
        PixelPipeline.cycles = 0;
      } else {
        PixelPipeline.cycles++;
      }
    }
  }

  // Function to completely reset the PixelPipeline
  // Probably should only do this at the end of a scanline
  static reset(): void {
    PixelFetcher.reset();
    PixelFifo.reset();

    PixelPipeline.cycles = 0;
    PixelPipeline.previousScrollX = 0;
    PixelPipeline.previousSpriteIndex = -1;
  }
}

function isFetchingSprite(): boolean {
  return PixelFetcher.currentTileType === 2 && PixelFetcher.currentStatus !== 0;
}

// Returns if we started fetching / we are fetching sprites
function _tryToFetchSprite(): boolean {
  // Check if sprites are enabled
  if (!Lcd.spriteDisplayEnable) {
    return false;
  }

  // Check if there is a sprite at the current location,
  // But only if we already have 8 pixels in the fifo,
  let pixelsRemainingInFifo = PixelFifo.numberOfPixelsInFifo - PixelFifo.currentIndex;
  if (pixelsRemainingInFifo < 8) {
    return false;
  }

  // Can only show one sprite per x value
  if (PixelFifo.currentIndex <= PixelPipeline.previousSpriteIndex) {
    return false;
  }

  for (let i = 0; i < Sprites.numberOfVisibleSprites; i++) {
    // Grab our sprite info from our visible sprites
    let spriteIndex: i32 = Sprites.getVisibleSpriteIndex(i);

    // Get the sprite info
    // Sprites occupy 4 bytes in the sprite attribute table
    // Byte0 - Y Position
    // Byte1 - X Position
    // Byte2 - Tile/Pattern Number
    // Byte3 - Attributes/Flags
    let spriteTableIndex: i32 = spriteIndex * 4;

    let spriteMemoryIndex: i32 = Graphics.memoryLocationSpriteAttributesTable + spriteTableIndex;

    let spriteYPosition: i32 = eightBitLoadFromGBMemory(spriteMemoryIndex + 0);
    let spriteXPosition: i32 = eightBitLoadFromGBMemory(spriteMemoryIndex + 1);

    // X is offset by 8. An off-screen value (X=0 or X>=168) hides the sprite
    spriteXPosition -= 8;
    // Y is offset by 16. An off-screen value (for example, Y=0 or Y>=160) hides the sprite.
    spriteYPosition -= 16;

    // Check if we are currently drawing the sprite
    // NOTE: Y Position was handled by the OAM Search,
    // and sprites are not affected by scroll Y
    // So we know the sprite is on this scanline
    // Also, we only want to check for the start of the sprite, not it's entire width
    // since the entire 8 x pixels of the tile are fetched at once
    if (PixelFifo.currentIndex === spriteXPosition) {
      // We need to fetch this sprite!

      // Get which line of the 8x8 or 8x16 tile.
      let spriteTileLine = Graphics.scanlineRegister - spriteYPosition;

      // Check if we are already fetching the sprite,
      // If not, start fetching it
      if (!PixelFetcher.isFetchingSpriteTileLine(spriteTileLine, spriteIndex)) {
        // Start fetching the sprite
        PixelFetcher.startSpriteFetch(spriteTileLine, spriteIndex);
        PixelPipeline.previousSpriteIndex = PixelFifo.currentIndex;
      }

      return true;
    }
  }

  // We didn't need to draw any of our sprites
  return false;
}

// Returns if we started fetching / we are fetching Window
function _tryToFetchWindow(): boolean {
  // First let's see if the window is enabled
  if (!Lcd.windowDisplayEnabled) {
    return false;
  }

  // Get our Window X and Y
  // WindowX is offset by 7
  let windowX: i32 = Graphics.windowX - 7;
  let windowY: i32 = Graphics.windowY;

  // Let's see if the window is on our scanline
  if (Graphics.scanlineRegister < windowY) {
    // Window is not within the current camera view
    return false;
  }

  // Let's see if window is on our current X
  if (PixelFifo.currentIndex < windowX) {
    return false;
  }

  // We need to draw window

  // First, if we were just fetching background, we need to clear the fifo
  // Said so in the ultimate gameboy talk
  if (PixelFetcher.currentTileType === 0) {
    PixelFifo.numberOfPixelsInFifo = PixelFifo.currentIndex;
  }

  // Get our TileMap
  let tileMapMemoryLocation = Graphics.memoryLocationTileMapSelectZeroStart;
  if (Lcd.windowTileMapDisplaySelect) {
    tileMapMemoryLocation = Graphics.memoryLocationTileMapSelectOneStart;
  }

  // Find which line of the tile we are rendering
  // (The line after the scanline, and modulo 8 (& 7 because it is faster))
  let tileLine: i32 = Graphics.scanlineRegister - windowY;
  tileLine = tileLine & 7;

  // Find the x/y coordinates of the tile

  // Get our Current X position of our pixel on the on the 160x144 camera
  // this is done by getting the current scroll X position,
  // and adding it do what X Value the scanline is drawing on the camera.
  let pixelXPositionInMap = PixelFifo.currentIndex - windowX;
  // This is to compensate wrapping
  if (pixelXPositionInMap >= 0x100) {
    pixelXPositionInMap -= 0x100;
  }
  // Get our current pixel y positon on the 160x144 camera (Row that the scanline draws across)
  let pixelYPositionInMap = Graphics.scanlineRegister - windowY;

  // Get the location of our tileId on the tileMap
  let tileIdInTileMapLocation = _bgWindowGetTileIdTileMapLocation(tileMapMemoryLocation, pixelXPositionInMap, pixelYPositionInMap);

  // Finally, check if we are already fetching, otherwise, start to
  if (!PixelFetcher.isFetchingWindowTileLine(tileLine, tileIdInTileMapLocation)) {
    // Fetch the window
    PixelFetcher.startWindowFetch(tileLine, tileIdInTileMapLocation);
  }

  return true;
}

// Returns if we started fetching / we are fetching Background
function _tryToFetchBackground(): boolean {
  // First let's see if background should be drawn
  if (!Cpu.GBCEnabled && !Lcd.bgDisplayEnabled) {
    // TODO: Handle for the OG Gameboy Case
    // Where this should just render white
    // http://gbdev.gg8.se/wiki/articles/LCDC#LCDC.0_-_BG.2FWindow_Display.2FPriority
    // So in our case, let's reset the fetcher, and pop 8 white pixels on the screen once we reach here.

    // In the meantime, let's just add 8 pixels to the fifo to avoid infinite loops
    let pixelsRemainingInFifo = PixelFifo.numberOfPixelsInFifo - PixelFifo.currentIndex;
    if (pixelsRemainingInFifo <= 8) {
      PixelFifo.numberOfPixelsInFifo += 8;
    }

    return false;
  }

  // NOTE: We don't care about Scroll Y Here.
  // Since once pixels are drawn, they are already out on the screen.

  // Check if Scroll X Changed
  if (PixelPipeline.previousScrollX !== Graphics.scrollX) {
    // We need to dump out some pixels, if we have them
    let pixelsRemainingInFifo = PixelFifo.numberOfPixelsInFifo - PixelFifo.currentIndex;
    if (pixelsRemainingInFifo > 0) {
      // Find out how much scrollX changed
      let scrollXDifference = Graphics.scrollX - PixelPipeline.previousScrollX;

      if (scrollXDifference > 0 && scrollXDifference < pixelsRemainingInFifo) {
        // TODO: Let's copy over the pixels we already got to the right position
        // This will be a performance, and timing improvement

        // For now, let's just clear the fifo
        PixelFifo.numberOfPixelsInFifo = PixelFifo.currentIndex;
      } else {
        // Let's just clear the fifo, as we can't go back in time and get the pixels
        PixelFifo.numberOfPixelsInFifo = PixelFifo.currentIndex;
      }
    }

    PixelPipeline.previousScrollX = Graphics.scrollX;
  }

  // We need to draw background

  // Get our TileMap
  let tileMapMemoryLocation = Graphics.memoryLocationTileMapSelectZeroStart;
  if (Lcd.bgWindowTileDataSelect) {
    tileMapMemoryLocation = Graphics.memoryLocationTileMapSelectOneStart;
  }

  // Get our current pixel y positon on the 160x144 camera (Row that the scanline draws across)
  // this is done by getting the current scroll Y position,
  // and adding it do what Y Value the scanline is drawing on the camera.
  let pixelYPositionInMap: i32 = Graphics.scanlineRegister + Graphics.scrollY;
  // Gameboy camera will "wrap" around the background map,
  // meaning that if the pixelValue is 350, then we need to subtract 256 (decimal) to get it's actual value
  // pixel values (scrollX and scrollY) range from 0x00 - 0xFF
  pixelYPositionInMap &= 0x100 - 1;

  // Get the X Position of the next tile / pixel in the map (see above)
  let pixelXPositionInMap = PixelFifo.numberOfPixelsInFifo + Graphics.scrollX;
  // This is to compensate wrapping
  if (pixelXPositionInMap >= 0x100) {
    pixelXPositionInMap -= 0x100;
  }

  // Find which line of the tile we are rendering
  // (The line after the scanline, and modulo 8 (& 7 because it is faster))
  let tileLine: i32 = pixelYPositionInMap & 7;

  // Get the location of our tileId on the tileMap
  let tileIdInTileMapLocation = _bgWindowGetTileIdTileMapLocation(tileMapMemoryLocation, pixelXPositionInMap, pixelYPositionInMap);

  // Finally, check if we are already fetching, otherwise, start to
  if (!PixelFetcher.isFetchingBackgroundTileLine(tileLine, tileIdInTileMapLocation)) {
    // Fetch the tile
    PixelFetcher.startBackgroundFetch(tileLine, tileIdInTileMapLocation);
  }

  return true;
}

function _bgWindowGetTileIdTileMapLocation(tileMapMemoryLocation: i32, pixelXPositionInMap: i32, pixelYPositionInMap: i32): i32 {
  // Divide our pixel position by 8 to get our tile.
  // Since, there are 256x256 pixels, and 32x32 tiles.
  // 256 / 8 = 32.
  // Also, bitshifting by 3, do do a division by 8
  // Need to use u16s, as they will be used to compute an address, which will cause weird errors and overflows
  let tileXPositionInMap = pixelXPositionInMap >> 3;
  let tileYPositionInMap = pixelYPositionInMap >> 3;

  // Get the location of our tileId on the tileMap
  // NOTE: (tileMap represents where each tile is displayed on the screen)
  // NOTE: (tile map represents the entire map, now just what is within the "camera")
  // For instance, if we have y pixel 144. 144 / 8 = 18. 18 * 32 = line address in map memory.
  // And we have x pixel 160. 160 / 8 = 20.
  // * 32, because remember, this is NOT only for the camera, the actual map is 32x32. Therefore, the next tile line of the map, is 32 byte offset.
  // Think like indexing a 2d array, as a 1d array and it make sense :)
  let tileIdInTileMapLocation = tileMapMemoryLocation + (tileYPositionInMap << 5) + tileXPositionInMap;

  return tileIdInTileMapLocation;
}
