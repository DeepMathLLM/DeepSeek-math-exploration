# 维数分布的证明、估计与边界

本附录区分纤维分解的证明、文献推论与有限实验。定量分布稿指 DeepSeek 的 `distribution_quantifiable_targets_v3.md`。归属见[贡献来源](../../contributions.md)，定理出处见[文献中的结论与适用范围](../../references/notes.md)。

| 命题 | 结论与范围 | 证明依据及相关估计 |
| --- | --- | --- |
| 纤维整数盒参数、基数和均匀条件独立性 | **已证。** 对任一自然域 $h$，$0\le x_i\le g_i$，$t_i=\sum_{j\ge i}(2x_j-g_j)$。均衡代表为 $t_i=(h_i-1)\bmod2$。 | ChatGPT Chat 第一轮 finite_stability_and_fibers.md §2 有完整正反映射，提示 1「固定主钩长的参数化与条件分布」交接。DeepSeek 《主钩纤维中的维数分布》 的修正 在「Critical correction」修正初稿 $x_i=g_i$ 为相邻后缀和上取整之差，并给 $t_i$ 的均值、方差。DeepSeek distribution_theory_v2.md §§5.1–5.3、distribution_theory_complete.md §§1.2、2.2 又混用 $x$ 与 $t$，提示 4 §4 恢复两者区别。 |
| 两测度的条件概率、点态亏损和事件上界 | **已证。** 权重归一化 $Z_P=\sum d_\lambda^2$，纤维概率 $Z_P/n!$，条件权重 $d_\lambda^2/Z_P$。将点态亏损界在事件上求和可加强纤维内估计。 | ChatGPT Chat 第一轮稿 §1 为亏损函数及其完整证明。DeepSeek results/distribution_report.md、《主钩纤维中的维数分布》 初稿含归一化或配对因子错误。提示 2「分布归一化与连续变分」修正归一化和配对因子比。DeepSeek 《主钩纤维中的维数分布》 的修正、第三次审查所核对的 distribution_tightened.md §§1–2 采纳并实施基本夹界精确核对。第四次审查稿 distribution_review.md §1 给正确事件界。DeepSeek scripts/distribution_verify.py 的 docstring 提到亏损指数和，程序实际只核 $d_{B(h)}^2\le Z_P(h)\le\lvert\mathcal F_h\rvert d_{B(h)}^2$。 |
| Plancherel 条件独立或统一次高斯 | **一般独立性为假；统一次高斯或高斯近似未证。** 例如 $n=7,h=(5,2)$ 的二维权重矩阵为 $\bigl(\begin{smallmatrix}196&441\\441&196\end{smallmatrix}\bigr)$。$h=(2)$ 的整个纤维则恰为均匀。 | ChatGPT Chat 第一轮稿 §2 只主张权重，提示 1 沿用。DeepSeek 分布综合稿 §§2.3、8.2 的首要缺口是从点态界跳到事件尾界，未控制对事件的求和和归一化。提示 4 §4 已纠偏。本次用普通逐格钩长式给出相依夹具。 |
| 两纤维的质量比 | **修正后已证。** 下界须有 $1/\lvert\mathcal F_{h'}\rvert$。$\log\lvert\mathcal F_h\rvert-2\log(W(h')/W(h))\to-\infty$ 是一个充分条件。 | DeepSeek distribution_tightened.md §3 已写对上界，随后用「大小至多多项式」和固定维数比推出指数小，推理失效。提示 3 §5 给指数级纤维反例和充分条件。DeepSeek 分布综合稿 §3.1 下界少分母。本次对 $h=(7), h'=(5,2)$ 复算，实际概率比 $462/637<400/441=(W(h)/W(h'))^2$。分布综合稿 §6.3 把一个和式上界趋零称为必要条件，也须改为充分。 |
| 纤维大小的全域上界 | **已证。** $\lvert\mathcal F_h\rvert\le e^{2\sqrt{n/e}}$。间距 4、末钩 1 族已有大小 $3^{r-1}$ 及 $n=2r^2-r$。 | 指数级反例见提示 3 §5。GPT 第四次审查稿 `distribution_review.md` §1 给 AM–GM 证明，也指出等间距 5、末钩 1 的 $4^{r-1}$ 在 $\sqrt n$ 尺度上系数更大，故间距 4 阶梯的系数不是全域上界。DeepSeek restart §1.3 重述全域界。 |
| 均匀测度下单纤维概率 | **已证。** 由 AM–GM 上界及 Hardy–Ramanujan 公式，得到在 $\sqrt n$ 尺度的指数上界，且对所有 $h$ 一致。 | DeepSeek distribution_theory_restart.md §2.5 把已有基数界代入分拆数渐近。应保留 $O(\log n)$ 或略减指数常数。原稿称相对于 $\sqrt n$「超指数小」不成立。 |
| Plancherel 下任一单纤维概率一致趋零 | **已证。** 从 BS 固定 $n$ 的轮廓波动在 $u=0$ 得秩高斯，再用连续极限分布函数一致收敛控跳跃。任意有界数量的纤维并同样趋零。 | GPT 提示 4 §4 及 `distribution_review.md` §3 首次在已定位材料给出该推论。DeepSeek distribution_analysis_fourth.md §1.1、分布修订稿 §§1–2 与定量分布稿 §1 采纳。直接否定 DeepSeek 分布综合稿 §6 的单一极大纤维占优猜想。BS 期刊式 (2.1)、(3.3)、Theorem 3.6 的旋转高度为 $2r$，据此换算到标准正态的系数表面上与 Sch §4 的写法差因子 2。正文只采用从 BS 原定理直接得出的非退化连续极限，无需固定方差。 |
| 单纤维概率的速率 | **部分已证。** 大亏损纤维有指数上界。若 $\Delta(h)\ge\alpha\sqrt n$ 且 $\alpha+\mathfrak d>1/\sqrt e$，则在 $\sqrt n$ 尺度指数衰减。秩论证本身仅给 $o(1)$。 | DeepSeek quantifiable_targets.md §1 尝试大亏损界，定量分布稿 §1.4 有组合上界。相关定量估计表中的 $\mathfrak d$ 符号错误，应为指数系数 $-2(\alpha+\mathfrak d-1/\sqrt e)$。秩的 $\sqrt{\log n}$ 尺度不足以判断细纤维的衰减速率。 |
| 维数矩与极大者事件 | **已证的恒等式。** $\mathbb E_U d_\lambda^2=n!/p(n)$，$\mathbb E_{\rm Pl} d_\lambda=\sum d_\lambda^3/n!$，$\mathbb E_U d_\lambda=I(n)/p(n)$。极大者事件按实际个数乘逐点概率。 | AP §7 的原有三项和式与渐近。DeepSeek 分布综合稿 §7.2 的 $\mathbb E_U d_\lambda$ 指数和早期分布稿 §4.1 的 Plancherel 矩混淆，经提示 4 §4 纠正。将 $\log \mathbb E_U d_\lambda$ 与 $\mathbb E_U\log d_\lambda$ 分开。ChatGPT Chat 第二轮摘要提到有限矩计算及 682 项核验，现有数学论证采用 AP §7 的恒等式。 |
| Plancherel 对数维数的典型主项 | **外部定理与直接换算。** $L_n/\sqrt n\to H/2$ 依概率且每个有限阶 $L^p$ 收敛。$H\approx1.87702830628$，平均对数维数的 $\log n$ 修正系数 $13/48$。 | Bufetov Theorem 1.1、Corollary 1.3 与 Sch Theorem 3.1。提示 4 §4 原来已正确区分，DeepSeek restart §4.1、《间距 3 与分布的结论汇总》 §3 等仍误标 CLT。该结论是缩放后收敛到常数，原文另列自然生长链的逐路径收敛问题。 |
| Tracy–Widom 与「典型超过最大」 | **撤回。** BDJ 的 $n^{1/6}$ 波动属于首行长度。维数及其平均都逐点受 $m_n$ 约束。 | 已定位早稿 distribution_theory.md §3.2 写 Tracy–Widom-like 的对数维数波动，其后加有自我更正。分布综合稿 §§4.2、5.3、9.3 仍引错误尺度并写典型大于最大。提示 4 纠正，DeepSeek restart §4.4 又把首行尺度写成 $n^{1/3}$。以 BDJ 原定理为准。 |
| 最大维数的 $\mathfrak d$ 与典型相对亏损 | **外部定理与直接推论。** $D_n=\mathfrak d\sqrt n+O(\sqrt n/\log n)$，$0<\mathfrak d\le H/2$。Plancherel 下 $(L_n-D_n)/\sqrt n\to H/2-\mathfrak d$。严格正性未从上述定理或本文推出。 | AE arXiv:2605.25995v1 Theorem 1、§4.3 与 Buf/Sch。提示 4 §4 正确换算。DeepSeek 定量分布稿 §3.2 把逐点 $m_n<\sqrt{n!}$ 当成 $\mathfrak d>0$ 的证明，第一处缺口是逐项严格不能保证极限严格。§3.3 把每个归一化间距的下界趋零当作约束整体消失，忽略了 $h_i-h_j\ge g(j-i)$ 可在 $j-i=\Theta(\sqrt n)$ 积累。仅凭秩的兼容性无法判定 $\sqrt n$ 次阶最优化。 |
| 最大维数常数的有限估计 | **数值描述。** $D_{345}/\sqrt{345}>D_{350}/\sqrt{350}$，该比值的单调增加断言因此失效。有限样本或有限回归不认证 $\mathfrak d\approx0.59$ 或其相对 $1/\sqrt e$ 的位置。 | DeepSeek distribution_gap3_mass_and_drefinement.md §1.3 已记录这次下降，与 定量分布稿 §§3.5–3.6 冲突。distribution_analysis_fourth.md §1.5 的约 $1.55$ 和 $31.06$ 也不是 $D_n/\sqrt n$ 在所报 $n$ 的值。按自然域最大值表抽行，用普通钩长式和对数重新计算。 |
| 均匀测度下的典型亏损 | **已证下界。** 存在 $c>0$，使 $\mathbb P_U(L_n-D_n\ge c n)\to1$，从而平均亏损也至少线性。另有全体极大者 $r/\sqrt n\to2/\pi$。 | GPT 提示 4 §4 及 distribution_review.md §4 用 Ver Theorem 4.4 和 VK/AE Proposition 2.1 证明。DeepSeek distribution_analysis_fourth.md §1.2、分布修订稿 §3 复述。本文将概率趋一的阈值选在极限截距差以下，写出固定有界 $B$ 和 $B'$ 的测度，并由 $\sum d_\lambda^2=n!$ 与 HR 公式直接比较 $m_n$。旧 DeepSeek 分布综合稿 §4.3及早期分布稿 §3.2 的 $\sqrt n$ 典型亏损口径撤回。 |
| 均匀亏损的 $0.033$–$0.0335$ | **可复现数值，完整主项和最优常数未定。** DeepSeek 的有限方框积分 只在有限方框上近似二重能量并除以 16。 | 定量分布稿 §§2.5–2.8 所给的候选常数来自有限方框上的数值，省略了 AE (2.5) 的尾项，未论证从轮廓收敛到全空间能量收敛，也无严格求积误差。DeepSeek 定量分布稿 用全极限截距差为阈值，依概率收敛只保证严格较小的阈值。见下文公式和可复现数值。 |
| 含最小间距 3 的纤维族质量 | **一般极限未由现有证明确定。** 《含间距 3 的纤维族质量计算》 的四个 $n$ 例精确复核，所求是质量下界与上界，且上界和都超过 1。 | DeepSeek distribution_theory_phase2.md §1.3 由逐纤维维数比 $<1$ 跳到族质量衰减，也误依赖未闭合的间距 3 全域排除。后期 distribution_gap3_mass.md 与 定量分布稿 §4 保留了粗求和路线的障碍，但没有证成其所列秩分层渐近或「所有方法不可能」。四个固定尺寸上的精确实验是 DeepSeek 新增。 |

## 有限方框能量与漏项

记 $a=\pi/\sqrt6$。将均匀极限形状转到 $u=x-y,\ v=x+y$ 后，轮廓为
$$
 f_U(u)=\frac{2}{a}\log(2\cosh(a u/2)),\qquad
 f_U(u)-\lvert u\rvert=\frac{2}{a}\log(1+e^{-a\lvert u\rvert})>0 .
$$
DeepSeek 求积对象是 $\Theta_{L,N}$，即在 $[-L,L]^2$ 上用 $N\times N$ 中点网格、跳过对角采样点近似
$$
 \iint\left(\frac{G_U(u)-G_U(v)}{u-v}\right)^2du\,dv,
 \qquad G_U(u)=f_U(u)-2\Omega(u/2).
$$
原稿称梯形求积，源代码实际取中点。$L=15,N=2000$ 时复现 $\Theta_{15,2000}=0.5358219407\ldots$，除以 16 得 $0.0334888713\ldots$。其余复算值见[分布计算样本](samples.md)。

AE (2.5) 还给出
$$
 \frac{\bar\theta_n(f_\lambda)}n=
 \int_{\lvert u\rvert\ge2}
   \left(n^{-1/2}f_\lambda(\sqrt n u)-\lvert u\rvert\right)
   \operatorname{arccosh}(\lvert u\rvert/2)\,du .
$$
只取 $3\le u\le4$，均匀极限轮廓的被积函数已经严格为正。该段对应第一象限远离坐标轴的有限区域，Ver 的局部收敛及 $1$-Lipschitz 性足以控制这个固定区间。因而尾项在均匀测度下也有概率趋一的线性下界。这个观察核实了漏项对主项的影响，无需假定全空间的加权尾积分收敛。$0.0335$ 是一项积分在有限域上的无认证误差近似，不能据此给出整个亏损的主项或最佳阈值。[AE, (2.4)–(2.7); Ver, Theorem 4.4]

## 家族求和的适用范围

固定 $r$，令 $y_i=h_i-h_{i+1}-3$（$i<r$）、$y_r=h_r-1$。$\min(h_i-h_{i+1})\ge3$ 的所有序列由
$$
 \sum_{i=1}^r i y_i=n-r-\tfrac32 r(r-1),\qquad y_i\ge0
$$
参数化。最小间距恰为 3 还须至少一个 $i<r$ 有 $y_i=0$。因此用不限制部件大小的分拆数替换，只产生上界。定量分布稿 §§4.2–4.4 不能把这种估计当作固定秩的渐近等式，也不能断言任何秩上任何形式的维数比求和都会失败。§4.5 的多项式秩概率界即使可得，逐纤维重复相加仍需面对纤维数而非秩数。§4.6 还把超出 $O(\sqrt{\log n})$ 的秩偏移一概判成固定的宏观偏移。能量论证需要 $\lvert G(0)\rvert$ 有固定正下界，无法给这里所称的线性亏损。

《含间距 3 的纤维族质量计算》 计算的是四个已选 $n$ 上、最小间距恰为 3 的完整纤维族。它从每个纤维取一个均衡点求下界，用纤维大小乘该点的质量求上界。$n=50,60,70,80$ 的四个上界分别为 $4.429465\ldots,6.624235\ldots,8.819503\ldots,12.60906\ldots$。它们大于概率的平凡上界 1，说明这项求和在这些样本上太松。族质量的结论既不依赖对一般间距 3 极大者的排除，也不能用上述有限和反过来证明一般排除。
