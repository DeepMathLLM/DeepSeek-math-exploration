# Ayyer–Prasad 问题 7.1 的证据说明

[研究报告 PDF](Q71_report.pdf)与[研究报告 Markdown](Q71_report.md)由 deepmath11小组署名。下表按报告中的结果提供证明、精确数据与适用范围。

| 结果 | 证据 |
| --- | --- |
| 自然域 $1\le n\le350$ 的最大值与全部取等分拆 | [自然域最大值表](evidence/compute/natural_maxima_1_350.json) |
| 间距至少为 4 的 3016 个可行分秩问题 | [受限分秩最大值表](evidence/compute/rank_profile_gap4_1_350.json) |
| 有限搜索的上界、覆盖与取等 | [有限搜索的正确性](evidence/compute/bounds.md)，[有限证书的核验与反例](evidence/compute/audit.md)，[独立核验结果](evidence/compute/verification.json) |
| 719 个已列等维对及其严格增维见证 | [等维对表](reproduce/inputs/collisions.json) |
| 主钩结构、间距 3 与并列的局部障碍 | [主钩结构、间距与并列的证明范围](evidence/structural/audit.md)，[局部移动数据](evidence/structural/structural_fixtures.json) |
| 单一底部或内部间距 3 的四钩证明与反例 | [完整归约](evidence/structural/de_review.md)，[精确比较数据](evidence/structural/de_regression.json) |
| 多处间距 3 的 465 个固定模板与推广障碍 | [固定模板计数与精确比值](evidence/structural/class_g_checks.json) |
| 两种测度下的纤维、亏损与有限实验 | [维数分布的证明、估计与边界](evidence/distribution/audit.md)，[分布计算样本](evidence/distribution/samples.md)，[复算数据](evidence/distribution/reproduced.json) |
| 研究贡献与文献依据 | [贡献来源](contributions.md)，[文献中的结论与适用范围](references/notes.md) |

## 精确表的读法

最大维数 `max_degree` 以十进制字符串保存。`maximizing_h` 列出全部取等主钩序列，`maximizing_partitions` 列出全部取等分拆。每个取等主钩序列对应一个共轭类，自共轭分拆只列一次。秩为 1 时，最小间距 `min_gap` 记为 `null`。比值以整数或既约分数保存。

域计数 `domain_count` 等于由严格上界排除的完整序列数 `strictly_pruned` 与进入精确比较的完整序列数 `exact_leaves` 之和。自然域表的 `rank_coverage` 给出逐秩计数。受限分秩表的严格对数凹逐组三个相邻可行秩检验，少于三个可行秩时该条件为空。

## 复算

在本说明所在目录执行以下命令。需要 Node.js 20 或更新版本，以及 Python 3.10 或更新版本。各脚本使用标准库。

```sh
python -X utf8 -B reproduce/verify.py
python -X utf8 -B evidence/structural/verify_de.py
node evidence/structural/verify_class_g.mjs
python -X utf8 -B evidence/distribution/verify_distribution.py
```

第一个命令以逐格钩长公式复算取等分拆及等维见证，以独立计数核对可行域，并在小规模域直接枚举。其余命令复算间距 3 的有限余域、模板和结构反例，以及分布样本。分布中的能量为有限方框上的数值求积。

若需从严格搜索重新生成两张完整表，可执行以下命令，再核验新生成的结果。

```sh
node reproduce/reproduce.mjs --out-dir reproduced-tables
python -X utf8 -B reproduce/verify.py --result-dir reproduced-tables
```

随附候选主钩只提供可行下界与切点。完整搜索按[上界与覆盖证明](evidence/compute/bounds.md)确定最大值及全部取等者。
