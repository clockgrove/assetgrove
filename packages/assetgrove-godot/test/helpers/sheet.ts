import { extensionContext } from "@clockgrove/assetgrove/testing";

const { raster } = extensionContext("t");

export const CELL = 64;
export const COLUMNS = 4;
export const ROWS = 2;

/** A contact sheet of identical solid figures on a flat background: 4 columns by 2 rows. */
export function contactSheet(): Uint8Array {
  const sheet = raster.create(CELL * COLUMNS, CELL * ROWS);
  for (let y = 0; y < sheet.height; y++)
    for (let x = 0; x < sheet.width; x++) raster.setPixel(sheet, x, y, [236, 230, 216, 255]);
  for (let row = 0; row < ROWS; row++)
    for (let column = 0; column < COLUMNS; column++)
      for (let y = 12; y < 52; y++)
        for (let x = 20; x < 44; x++)
          raster.setPixel(sheet, column * CELL + x, row * CELL + y, [150, 70, 40, 255]);
  return raster.encodePng(sheet);
}
