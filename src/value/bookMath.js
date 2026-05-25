export function bestAskFromBook(book) {
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const eligible = asks
    .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size) && ask.price > 0 && ask.size > 0)
    .sort((a, b) => a.price - b.price);
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
