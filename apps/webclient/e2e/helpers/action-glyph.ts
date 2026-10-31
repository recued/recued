import { expect, type Locator, type Page } from '@playwright/test';

/** Use a native click on the drawing itself, so delegation must also work
 * when the event starts at an SVG element rather than its button. */
export const clickActionGlyph = async (page: Page, control: Locator): Promise<void> => {
  const prepared: { point?: { x: number; y: number } } = {};
  // Like Locator.click, re-resolve after a repaint detaches a control. Retry
  // only this read-only preparation; never repeat a possibly completed action.
  await expect(async () => {
    await control.scrollIntoViewIfNeeded();
    prepared.point = await control.locator('svg path, svg circle, svg rect, svg line, svg polyline').first().evaluate(element => {
      const shape = element as SVGGeometryElement;
      const point = shape.getPointAtLength(shape.getTotalLength() * 0.37);
      const matrix = shape.getScreenCTM();
      if (!matrix) throw new Error('The action glyph is not rendered.');
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
  }).toPass({ timeout: 10_000 });
  if (!prepared.point) throw new Error('The action glyph was not ready.');
  await page.mouse.click(prepared.point.x, prepared.point.y);
};
