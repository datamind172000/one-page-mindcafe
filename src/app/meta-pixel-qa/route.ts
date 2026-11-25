const PIXEL_ID = "1667702978300497";
const TEST_PATH = "/meta-pixel-qa";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (
    process.env.VERCEL_ENV !== "preview" ||
    new URL(request.url).pathname !== TEST_PATH ||
    new URL(request.url).search
  ) {
    return new Response(null, { status: 404 });
  }

  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageView test</title>
</head>
<body>
<h1>PageView test</h1>
<p>This sends one test PageView to Meta. No customer or shopping activity is used.</p>
<button type="button" id="send">Send test PageView</button>
<p id="status" role="status"></p>
<script nonce="${nonce}">
const pixelId = ${JSON.stringify(PIXEL_ID)};
const button = document.getElementById("send");
const status = document.getElementById("status");
function safeContext() {
  return location.pathname === ${JSON.stringify(TEST_PATH)} &&
    !location.search && !location.hash && !document.referrer;
}
button.addEventListener("click", () => {
  if (!safeContext()) {
    status.textContent = "Open the clean test URL directly in a new tab.";
    return;
  }
  button.disabled = true;
  if (window.fbq) {
    status.textContent = "Another Pixel is already present. Test stopped.";
    return;
  }
  const pixel = function () {
    if (pixel.callMethod) pixel.callMethod.apply(pixel, arguments);
    else pixel.queue.push(arguments);
  };
  pixel.queue = [];
  pixel.push = pixel;
  pixel.loaded = true;
  pixel.version = "2.0";
  window.fbq = window._fbq = pixel;
  const script = document.createElement("script");
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  script.onload = () => {
    if (!safeContext()) return;
    pixel("set", "autoConfig", false, pixelId);
    pixel("init", pixelId);
    pixel("trackSingle", pixelId, "PageView");
    status.textContent = "PageView called. Check Chrome Network and Meta Test Events for receipt.";
  };
  script.onerror = () => {
    status.textContent = "Meta Pixel script could not load.";
  };
  document.head.append(script);
});
</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net; img-src https://www.facebook.com; connect-src https://www.facebook.com https://connect.facebook.net; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
