import type { Locator } from '@playwright/test';

/** Measure computed colors, rather than antialiased screenshot pixels. */
export const textContrast = (control: Locator, placeholder = false): Promise<number> => control.evaluate((element, placeholder) => {
  const foreground = getComputedStyle(element, placeholder ? '::placeholder' : null).color;
  const background = getComputedStyle(element).backgroundColor;
  const luminance = (rgb: string): number => {
    const channels = rgb.match(/[\d.]+/gu)!.slice(0, 3).map(value => Number(value) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}, placeholder);
