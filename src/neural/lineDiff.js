// 行级 diff（LCS 动态规划）：返回 [{t: ' '|'-'|'+', s: 行文本}]。
// 两侧各超 1500 行时返回 null（O(n·m) 矩阵约 9MB / 数百万次比较，超长文本不值得在界面里算）。
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  if (A.length > 1500 || B.length > 1500) return null;
  const n = A.length, m = B.length;
  const dp = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({t: ' ', s: A[i]}); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({t: '-', s: A[i]}); i++; }
    else { out.push({t: '+', s: B[j]}); j++; }
  }
  while (i < n) out.push({t: '-', s: A[i++]});
  while (j < m) out.push({t: '+', s: B[j++]});
  return out;
}
