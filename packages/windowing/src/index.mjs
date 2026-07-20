export const COMPACT_HEIGHT = 88;
export const DEFAULT_OVERLAY_WIDTH = 590;
export const MIN_OVERLAY_WIDTH = 420;
export const MAX_OVERLAY_WIDTH = 760;
export const DEFAULT_EXPANDED_HEIGHT = 414;
export const MIN_EXPANDED_HEIGHT = 300;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clampBounds(bounds, workArea, expanded) {
  const width = clamp(Math.round(bounds.width), MIN_OVERLAY_WIDTH, Math.min(MAX_OVERLAY_WIDTH, workArea.width));
  const height = expanded
    ? clamp(Math.round(bounds.height), MIN_EXPANDED_HEIGHT, workArea.height)
    : COMPACT_HEIGHT;
  const x = clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width);
  const y = clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - Math.min(height, COMPACT_HEIGHT));
  return { x, y, width, height };
}

export function defaultCompactBounds(workArea) {
  const width = Math.min(DEFAULT_OVERLAY_WIDTH, workArea.width);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + 24),
    width,
    height: COMPACT_HEIGHT
  };
}

export function transitionBounds(current, workArea, expanded, remembered = {}) {
  if (!expanded) {
    return clampBounds({ ...current, width: remembered.compactWidth ?? current.width, height: COMPACT_HEIGHT }, workArea, false);
  }
  const desiredHeight = remembered.expandedHeight ?? DEFAULT_EXPANDED_HEIGHT;
  const growsDown = current.y + desiredHeight <= workArea.y + workArea.height;
  const y = growsDown ? current.y : Math.max(workArea.y, current.y + COMPACT_HEIGHT - desiredHeight);
  return clampBounds({ ...current, y, height: desiredHeight }, workArea, true);
}

export function boundsEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function pickerPresentationBounds(anchorBounds, workArea, desiredHeight, maximumHeight = 420) {
  const desired = clamp(Math.round(desiredHeight), 120, maximumHeight);
  const workAreaBottom = workArea.y + workArea.height;
  const belowSpace = Math.max(0, workAreaBottom - (anchorBounds.y + anchorBounds.height));
  const aboveSpace = Math.max(0, anchorBounds.y - workArea.y);
  const placement = belowSpace >= desired || belowSpace >= aboveSpace ? "below" : "above";
  const available = placement === "below" ? belowSpace : aboveSpace;
  const viewportHeight = Math.max(0, Math.min(desired, available));
  const bounds = {
    x: anchorBounds.x,
    y: placement === "above" ? anchorBounds.y - viewportHeight : anchorBounds.y,
    width: anchorBounds.width,
    height: anchorBounds.height + viewportHeight
  };
  return { bounds, placement, viewportHeight, surfaceOffsetY: placement === "above" ? viewportHeight : 0 };
}
