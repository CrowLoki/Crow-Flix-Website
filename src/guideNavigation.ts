export const GUIDE_PAGE_SIZE = 100;

export type GuidePage<T> = {
  channels: T[];
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
};

/** Keep every guide channel reachable while bounding one rendered timeline page. */
export function paginateGuideChannels<T>(
  channels: readonly T[],
  requestedPage: number,
  pageSize = GUIDE_PAGE_SIZE,
): GuidePage<T> {
  const size = Number.isInteger(pageSize) && pageSize > 0
    ? pageSize
    : GUIDE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(channels.length / size));
  const page = Math.min(
    pageCount,
    Math.max(1, Number.isInteger(requestedPage) ? requestedPage : 1),
  );
  const offset = (page - 1) * size;
  const selected = channels.slice(offset, offset + size);
  return {
    channels: selected,
    page,
    pageCount,
    start: selected.length ? offset + 1 : 0,
    end: offset + selected.length,
    total: channels.length,
  };
}
