export function bestAskFromBook(book) {
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const eligible = asks
    .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size) && ask.price > 0 && ask.size > 0)
    .sort((a, b) => a.price - b.price);
  return eligible[0] ?? null;
}

export function bestBidFromBook(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const eligible = bids
    .filter((bid) => Number.isFinite(bid.price) && Number.isFinite(bid.size) && bid.price > 0 && bid.size > 0)
    .sort((a, b) => b.price - a.price);
  return eligible[0] ?? null;
}

export function estimateBuyCostForSharesFromBook(book, targetShares, maxPrice) {
  const asks = Array.isArray(book?.asks) ? [...book.asks] : [];
  const remainingTarget = Number(targetShares ?? 0);
  const max = Number(maxPrice ?? 0);
  if (!Number.isFinite(remainingTarget) || !Number.isFinite(max) || remainingTarget <= 0 || max <= 0) {
    return null;
  }

  asks.sort((a, b) => a.price - b.price);
  const eligible = asks.filter((ask) =>
    Number.isFinite(ask.price) &&
    Number.isFinite(ask.size) &&
    ask.price > 0 &&
    ask.size > 0 &&
    ask.price <= max
  );

  let remainingShares = remainingTarget;
  let spentUsdc = 0;
  let filledShares = 0;
  const fills = [];

  for (const ask of eligible) {
    if (remainingShares <= 0) break;
    const fillShares = Math.min(remainingShares, ask.size);
    const fillSpent = fillShares * ask.price;
    filledShares += fillShares;
    spentUsdc += fillSpent;
    remainingShares -= fillShares;
    fills.push({
      price: ask.price,
      shares: fillShares,
      spentUsdc: fillSpent,
    });
  }

  if (filledShares <= 0) return null;
  return {
    bestAsk: eligible[0]?.price ?? asks[0]?.price ?? null,
    avgFillPrice: spentUsdc / filledShares,
    fillShares: filledShares,
    spentUsdc,
    unfilledShares: Math.max(0, remainingShares),
    fullyFilled: remainingShares <= 1e-9,
    askLevelsConsidered: eligible.length,
    fills,
  };
}

export function estimateSellProceedsForSharesFromBook(book, targetShares, minPrice) {
  const bids = Array.isArray(book?.bids) ? [...book.bids] : [];
  const remainingTarget = Number(targetShares ?? 0);
  const min = Number(minPrice ?? 0);
  if (!Number.isFinite(remainingTarget) || !Number.isFinite(min) || remainingTarget <= 0 || min <= 0) {
    return null;
  }

  bids.sort((a, b) => b.price - a.price);
  const eligible = bids.filter((bid) =>
    Number.isFinite(bid.price) &&
    Number.isFinite(bid.size) &&
    bid.price > 0 &&
    bid.size > 0 &&
    bid.price >= min
  );

  let remainingShares = remainingTarget;
  let proceedsUsdc = 0;
  let soldShares = 0;
  const fills = [];

  for (const bid of eligible) {
    if (remainingShares <= 0) break;
    const fillShares = Math.min(remainingShares, bid.size);
    const fillProceeds = fillShares * bid.price;
    soldShares += fillShares;
    proceedsUsdc += fillProceeds;
    remainingShares -= fillShares;
    fills.push({
      price: bid.price,
      shares: fillShares,
      proceedsUsdc: fillProceeds,
    });
  }

  if (soldShares <= 0) return null;
  return {
    bestBid: eligible[0]?.price ?? bids[0]?.price ?? null,
    avgFillPrice: proceedsUsdc / soldShares,
    soldShares,
    proceedsUsdc,
    unfilledShares: Math.max(0, remainingShares),
    fullyFilled: remainingShares <= 1e-9,
    bidLevelsConsidered: eligible.length,
    fills,
  };
}
