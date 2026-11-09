/** D-335 slice J (2026-11-04) — a CAPTCHA a page shows and nobody has solved, named by its maker.
 *
 *  The owner: "captcha blocks login form which can be observed sooner". A write by page asks the
 *  page this once it is done (and, after a click or a send, the page the tab then shows), and a
 *  sequence of steps stops on the answer: the AI cannot solve one, and the owner can, in the
 *  browser, before asking again.
 *
 *  What counts: a challenge frame or box a person can see, from reCAPTCHA, hCaptcha, Cloudflare
 *  (Turnstile, or its full-page check), Arkose, DataDome or PerimeterX, whose answer field (where
 *  the maker puts its token once solved) is still empty. An invisible reCAPTCHA, which shows only
 *  a badge and asks nothing, is not one; neither is a challenge frame the page keeps hidden until
 *  it needs it.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: everything it uses is declared inside it. */
export const pageChallenge = (): string | null => {
  const shown = (element: Element): boolean => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 1 && box.height > 1 && style.visibility !== 'hidden' && style.display !== 'none'
      && style.opacity !== '0';
  };
  const answered = (field: string): boolean => [...document.querySelectorAll(`[name="${field}"]`)]
    .some((element) => ((element as HTMLInputElement).value ?? '').trim() !== '');
  const makers: Array<{ name: string; frame: RegExp; invisible?: RegExp; answer?: string }> = [
    { name: 'reCAPTCHA', frame: /\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/, invisible: /[?&]size=invisible/,
      answer: 'g-recaptcha-response' },
    { name: 'hCaptcha', frame: /hcaptcha\.com\/captcha|\/hcaptcha\.html/, answer: 'h-captcha-response' },
    { name: 'Cloudflare Turnstile', frame: /challenges\.cloudflare\.com/, answer: 'cf-turnstile-response' },
    { name: 'Arkose', frame: /arkoselabs\.com|funcaptcha\.com/ },
    { name: 'DataDome', frame: /captcha-delivery\.com/ },
  ];
  const frames = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[];
  for (const maker of makers) {
    const showing = frames.some((frame) => maker.frame.test(frame.src)
      && !(maker.invisible?.test(frame.src) ?? false) && shown(frame));
    if (showing && !(maker.answer !== undefined && answered(maker.answer))) return maker.name;
  }
  // Cloudflare's full-page check ("Just a moment…"), which stands in for the page itself.
  if (document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running, .cf-browser-verification')) {
    return 'Cloudflare';
  }
  const px = document.querySelector('#px-captcha');
  if (px && shown(px)) return 'PerimeterX';
  return null;
};
