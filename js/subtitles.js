/**
 * subtitles.js
 * Small helper to turn an .srt file's text into a valid WebVTT blob URL
 * so it can be attached to a <video><track> element.
 */

function srtTimeToVtt(t) {
  // "00:00:01,234" -> "00:00:01.234"
  return t.replace(',', '.');
}

function srtToVtt(srtText) {
  const lines = srtText.replace(/\r/g, '').split('\n');
  const timeLine = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;
  let out = 'WEBVTT\n\n';

  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(timeLine);
    if (match) {
      out += `${srtTimeToVtt(match[1])} --> ${srtTimeToVtt(match[2])}\n`;
    } else if (/^\d+$/.test(line)) {
      // cue index line from .srt, WebVTT doesn't need it
      continue;
    } else {
      out += raw + '\n';
    }
  }
  return out;
}

/**
 * Accepts raw subtitle text (srt or vtt) and returns an object-URL
 * pointing to a WebVTT blob, ready to use as a <track src="">.
 */
function subtitleTextToBlobUrl(text) {
  const isVtt = text.trim().toUpperCase().startsWith('WEBVTT');
  const vttText = isVtt ? text : srtToVtt(text);
  const blob = new Blob([vttText], { type: 'text/vtt' });
  return URL.createObjectURL(blob);
}

async function subtitleUrlToBlobUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('subtitle fetch failed: ' + res.status);
  const text = await res.text();
  return subtitleTextToBlobUrl(text);
}
