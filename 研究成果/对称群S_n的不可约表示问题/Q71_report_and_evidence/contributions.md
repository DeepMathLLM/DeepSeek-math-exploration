# 问题 7.1 的贡献来源

deepmath11小组设定研究任务、提供材料并组织提示交接。两轮 ChatGPT Chat 研究均未以 DeepSeek 的工作为输入，两轮完整稿未直接交给 DeepSeek。第一次提示传递第一轮成果，第二次提示结合两轮 Chat 和 DeepSeek 的阶段成果，第三、四次提示审查已有结果并补充证明、反例与计算。

各项归属以可定位的数学产出为依据。文件名和章节指向原材料，中文内容名称用于说明相应材料的主题。附录及数据链接指向本包所含的可复核证据。

## 主钩结构与间距

| 成果 | 归属与适用范围 | 原材料与证据 |
| --- | --- | --- |
| S01 固定主钩纤维的极大性及取等 | ChatGPT Chat 第一轮证明均衡代表最优，全部取等者为它及其共轭。GPT 在第一次提示交接，DeepSeek 分解单体、两体因子并作有限复核。 | ChatGPT Chat 第一轮 `theorem_fixed_diagonal_hooks.md` 的命题与证明。DeepSeek 的三项初步结论验证，Result 1。 |
| S02 全局极大者相邻主钩至少相差 3 | ChatGPT Chat 第一轮证明奇、偶区块的同步伸展，第一次提示转达。DeepSeek 检验移动并发展保秩与变秩比值。GPT 第三次审查给出外钩 7 与偶块 $(4,2)$ 的交互因子 $25/32$，正文采用第一轮的整体乘积证明。 | ChatGPT Chat 第一轮 `theorem_odd_runs.md`、`theorem_simultaneous_even_runs.md`。DeepSeek 的三项初步结论验证，Result 2。 |
| S03 固定行数上限的连续邻域与整数邻域 | ChatGPT Chat 第二轮给出整数极大点到连续极大点的距离界和中心包围方法，第二次提示传入。DeepSeek 实现原型。GPT 第三次审查发现阶梯偏移、投影及截窗错误，另证纯整数半径 $d-1$、严格比较与取等完备性。 | ChatGPT Chat 第二轮 `continuous_integer_proximity.md` §§2–4。DeepSeek `certified_max_search.py` 的中心和搜索窗。GPT 第三次审查 `Q71_整数邻域认证与并列极大者.md` 的层分解与证明。 |
| S04 单对外拉的障碍和替代移动 | ChatGPT Chat 第二轮构造 $H(k,M)$，给出 $M=3$ 时中央外拉降维的无限族，第二次提示传入。DeepSeek 复算比值，分析局部外钩因子与替代方向。GPT 第三次审查证明纯族在 $M\ge1,\ k\ge2M+2$ 时首末转移增维，并给出三种其他移动同时失效的反例。 | ChatGPT Chat 第二轮 `gap3_infinite_family.md` §§1–3。DeepSeek `gap3_rescue_proof.md` §3.4。GPT 第三次审查的纯族首末转移证明及三种移动的反例。 |
| S05 末钩分裂、顶部与低秩间距 | DeepSeek 提出并检验顶部和三钩底部的比较。GPT 第四次审查证明 $b\ge6$ 的末钩分裂、顶部间距、三钩底部与大末钩的情形。DeepSeek 后续复核末钩上界与跨秩反例。 | GPT 第四次审查 `bottom_hook_split.md`、`top_gap3_proof.md`、`rank3_bottom_gap3_proof.md`、`dense_bottom_and_large_last_proof.md`。DeepSeek 的三钩底部比较及跨秩反例与末钩上界。 |
| S06 含间距 3 候选的对数亏损 | DeepSeek 提出通过宏观秩或轮廓差异得到指数亏损的路线。GPT 第三次审查推导极大者的秩极限，第四次审查再由改变一处间距和分支律证明存在维数至少为 $m_n/n$ 的含间距 3 候选，排除统一指数亏损。DeepSeek 后续保留此障碍。 | DeepSeek 的指数亏损主张。GPT 第三次审查 `typec_review.md` 中的极限形状，第四次审查 `no_exponential_gap3_deficit.md` 的命题及证明。 |
| S07 末钩为 1、单一底部或内部间距 3 | DeepSeek 提出尾部比较、分区、奇偶因子、尾积和有限检验。GPT 第四次审查给出固定移动失效的反例，纠正守和条件与外钩乘积。报告整理补齐两种四钩情形的大参数归约，分别复核余下的 63 个与 110 个输入。一般秩仍有余域。 | DeepSeek `class_b_hr1_global_proof_v3.md`、`class_d_d2to18_proof_v9.md`、`class_e_unified_proof_v4.md`。GPT 第四次审查 `gap_review.md`。[证明与反例](evidence/structural/de_review.md) |
| S08 多处间距 3 的固定模板 | DeepSeek 提出从单处归约的路线，并计算首钩为 34、秩 4 至 9 的 465 个固定模板。GPT 审查指出额外交互与覆盖缺口。DeepSeek 自审给出扩张样本与失效移动。报告整理分别复核固定表和扩张域，确认保守下界及实际最小维数比，并给出平移和高秩反例。 | DeepSeek `class_g_final_closure_proof_v3.md` §§4.6–4.8、`class_g_v3_reaudit.md` §§4–6。GPT 第三、四次审查 `gap_review.md` 的多处间距比较。[固定模板与精确反例](evidence/structural/class_g_checks.json) |

## 有限最大值

| 成果 | 归属与适用范围 | 原材料与证据 |
| --- | --- | --- |
| C01 自然域最大值与全部取等者 | DeepSeek 校正 $n=47$ 至 $50$ 的旧候选并逐项精确枚举至 $100$。GPT 第三次审查严格认证 $1\le n\le200$，第四次审查认证 $201\le n\le350$。报告整理按统一搜索重算两段并独立核验，范围内每个 $n$ 的全局极大分拆组成一个共轭类。 | DeepSeek `exact_max_full.py`、`exact_full_100.json`。GPT 第三次审查 `certified_full_200.json`，第四次审查 `natural_maxima_201_350.json`。[自然域最大值表](evidence/compute/natural_maxima_1_350.json) |
| C02 受限分秩证书 | DeepSeek 探索按秩分解、松弛坐标和降秩比较。GPT 第四次审查严格搜索间距至少为 4 的 3016 个可行 $(n,r)$，得出 $1\le n\le350$ 的受限秩曲线严格单峰且严格对数凹。报告整理复算各秩最优值、取等和覆盖。 | DeepSeek `g2_final_comprehensive_proof.md`。GPT 第四次审查 `uniqueness_review.md` §4。[受限分秩最大值表](evidence/compute/rank_profile_gap4_1_350.json) |
| C03 候选搜索与严格认证 | DeepSeek 的大规模搜索提供可行候选与局部改进。GPT 第三、四次审查检查错和、形状构造、域限制和次优筛选。报告整理核对 16 张候选表，所查各表合并后仍有 52 个尺寸未含真极大主钩，并复核 $n=69,r=4$ 等精确反例。 | DeepSeek `fix_and_certify.py`、`g2_extend_certificate.py`。GPT 第四次审查 `compute_review.md`。[核验及反例](evidence/compute/audit.md) |

## 等维与跨秩

| 成果 | 归属与适用范围 | 原材料与证据 |
| --- | --- | --- |
| T01 等维族、第三钩因子与全局并列 | DeepSeek 分析 $W$ 的等值端点并给出相邻外拉的第三钩因子严格不等式。GPT 保留该局部结果，并用 $n=41$ 的同秩例和 $n=88$ 的跨秩例区分等维端点与全局并列。 | DeepSeek `CJ_STRICT_PROOF.md` §§1–4。GPT 第三次审查 `typec_review.md`，第四次审查 `uniqueness_review.md` §§1–2。 |
| T02 层分解、四定向与已列等维对 | GPT 第三次审查给出同向层分解、原始层判据和可分端点的严格比较。DeepSeek 生成 719 对并筛查四定向，另列 28 条严格增维移动，其中覆盖目标 41 对中的 26 对。GPT 第四次审查证明命题 5 的四种定向均原始，并对 719 对逐项认证严格增维见证。报告整理独立复算。 | GPT `Q71_整数邻域认证与并列极大者.md`、`type_c_four_orientations.md`。DeepSeek `phase_c_equal_w_full.json`、`gap4_primitive_improvers.json`。[719 对的精确数据](reproduce/inputs/collisions.json) |
| T03 跨秩移动与解析单峰的范围 | DeepSeek 研究删钩、松弛量与秩差，提出分域比较。GPT 第四次审查给出完整删钩比、末钩分裂以及 $n=28,47,69,71$ 的边界案例。DeepSeek 后续核查局部失效。报告整理穷尽三个尺寸的受限单接收删钩，核对末积错误。一般解析单峰仍未证明。 | DeepSeek `cross_rank_G4_balanced_slack_proof.md`、`cross_rank_G4_analytical_bound.md`。GPT 第四次审查 `rank_drop_details.md`。[跨秩核验](evidence/compute/verification.json) |

## 两种测度下的维数分布

| 成果 | 归属与适用范围 | 原材料与证据 |
| --- | --- | --- |
| D01 纤维坐标、条件分布与点态损失 | ChatGPT Chat 第一轮给出整数盒坐标、纤维计数、均匀条件独立和点态亏损界。GPT 第二次提示纠正 $d_\lambda^2$ 条件权重的归一化和两体因子。DeepSeek 采纳修正，计算条件均值方差并检验基本夹界。 | ChatGPT Chat 第一轮 `finite_stability_and_fibers.md` §§1–2。DeepSeek `distribution_tightened.md` §§1–2、4–5，`distribution_verify.py`。 |
| D02 跨纤维界和变分模型 | DeepSeek 提出连续剖面与数值模型。GPT 第二、三次提示修正 $4\rho^2$ 系数及概率估计，指出 $n=200$ 的约 $7\%$ 为上界。GPT 第四次审查证明全域纤维基数上界，补足跨纤维比值下界所需的分母，并区分矩、平均对数和典型对数。 | DeepSeek `variational_solution_v2.md` §3.1、`distribution_tightened.md` §3。GPT 第三次审查 `typec_review.md`，第四次审查 `distribution_review.md` §§1–2。 |
| D03 单纤维反集中与均匀线性亏损 | GPT 第四次审查由 Bogachev–Su 的轮廓波动推出 Plancherel 单纤维质量一致趋零，由 Vershik 极限形状与 Vershik–Kerov、Aggarwal–Elboim 的能量公式推出均匀典型亏损至少线性。DeepSeek 在后续稿中整理两项推论。 | GPT 第四次审查 `distribution_review.md` §§3–4。DeepSeek `distribution_analysis_fourth.md`、`distribution_quantifiable_targets_v3.md` §§1–2。[文献定理的适用范围](references/notes.md) |
| D04 单纤维上界、有限能量及间距 3 纤维族 | DeepSeek 给出均匀单纤维上界、大亏损纤维的界和有限方框积分，并在 $n=50,60,70,80$ 估计间距 3 纤维族质量。报告整理复算四个尺寸及有限方框，指出上界之和都超过 1，核对能量尾项及阈值 $\alpha+\mathfrak d>1/\sqrt e$。 | DeepSeek `distribution_quantifiable_targets_v3.md` §§1–4、`distribution_gap3_mass_and_drefinement.md` §§1–3、5.2，`compute_uniform_deficit_constant.py`、`gap3_mass_compute.py`。[分布样本与范围](evidence/distribution/samples.md) |
