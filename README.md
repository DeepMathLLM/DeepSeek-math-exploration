# 45年猜想，7个顶点：DeepSeek自主突破组合数学难题

## AI X Math 社区 × 同济 DeepMath 团队，公开探索国产大模型的数学能力边界

如果一个数学猜想悬置了45年，国产大模型能否找到突破口？

这一次，答案是一组可以独立核验的数学对象：

> **DeepSeek 找到了一个只有7个顶点的反例，用23个 Maximal Clique 击穿了 Tomescu 猜想预测的21个。**

这一成果来自 **AI X Math 社区** 发起、**同济 DeepMath 团队** 提供智能体系统与 DeepSeek API 支持的前沿数学探索活动。

**活动预告 → [查看微信公众号原文](https://mp.weixin.qq.com/s/51f4bpLQu6iAFu7iC2sAPQ)**

活动面向11个数学小组展开，参与者均为数学专业研究生及以上学历。每个小组围绕一个尚无已知完整解答的数学问题，在24小时内集中攻坚探索，最终由人工核验数学结果。

在 Tomescu 猜想这一任务中，人工只提供原始问题并启动系统，没有提供关键构造、证明思路或中途提示。DeepSeek 自主完成了问题分析、构造搜索和反例发现，研究者随后对结果进行数学核验。

这正是本次活动希望公开回答的问题：

> **国产大模型能否真正进入前沿数学研究现场？**

## 一个提出于1981年的猜想

1965年，Moon 和 Moser 确定了普通图中 Maximal Clique 数量的最大可能值。1981年，Tomescu 将这一问题推广到 uniform hypergraph，并提出猜想。对于给定顶点数和 hyperedge 规模，一类具有规则分块结构的 hypergraph 能够实现 Maximal Clique 数量的最大值。

设 $`f(n,d)`$ 表示具有 $`n`$ 个顶点的 $`d`$-uniform hypergraph 中，Maximal Clique 数量的最大值。Tomescu 猜想认为

```math
f(n,d)=\psi(n,d),
```

其中

```math
\psi(n,d)=\max_{n_1+\cdots+n_k=n}\prod_i\binom{n_i}{d-1}.
```

这里，$`d`$-uniform hypergraph 是指每条 hyperedge 都恰好包含 $`d`$ 个顶点的 hypergraph。对于这样的 hypergraph，如果一个顶点集合中的任意 $`d`$ 个顶点都构成一条 hyperedge，那么这个集合就称为一个 Clique。如果已经无法再加入其他顶点而保持 Clique 的性质，则称为 Maximal Clique。

Tomescu 猜想的核心思想，是通过将顶点划分为若干组，利用分块结构获得尽可能多的 Maximal Clique。它将经典图论中的极值问题推广到了更一般的 hypergraph 框架，也因此成为 uniform hypergraph 极值理论中一个重要的研究问题。

然而，DeepSeek 找到的一个小规模反例，揭示了这种规则分块结构并不总能达到 Maximal Clique 数量的真正上界。

## 7个顶点上的23个 Maximal Clique

DeepSeek 找到的反例非常具体。

考虑顶点集

```math
[7]=\{1,2,3,4,5,6,7\}.
```

首先，选取以下12个三元组

```math
\begin{aligned}
F=\{&123,145,246,127,156,346,\\ &137,467,235,237,257,357\}.
\end{aligned}
```

随后，以这7个顶点的全部三元组为基础，去掉集合 $`F`$ 中的12个三元组，将剩余部分定义为 hypergraph $`H(3,7)`$ 的 hyperedge 集

```math
E(H(3,7))=\binom{[7]}{3}\setminus F.
```

这个构造的规模很小，但具有一个关键性质。

7个顶点总共可以组成

```math
\binom{7}{3}=35
```

个不同的三元组。去掉 $`F`$ 中的12个三元组后，剩余的 hyperedge 数量为

```math
35-12=\boxed{23}.
```

也就是说，构造得到的 hypergraph $`H(3,7)`$ 恰好包含23条 hyperedge。

更重要的是，这12个被排除的三元组具有如下性质。

> **任意4个顶点都至少包含 $`F`$ 中的一个三元组。**

这意味着，在构造得到的 hypergraph $`H(3,7)`$ 中，不可能存在由4个顶点组成的 Clique，因为任意4个顶点所包含的4个三元组中，至少有一个不属于 hyperedge 集。

另一方面，$`H(3,7)`$ 中的每一条 hyperedge 本身都包含3个顶点，构成一个3顶点 Clique。由于不存在4顶点 Clique，这些 Clique 都无法通过增加一个顶点继续扩展。

因此，23条 hyperedge 全部都是 Maximal Clique，从而得到

```math
f(7,3)\ge23.
```

再来看 Tomescu 猜想在这一参数下给出的预测值

```math
\psi(7,3)=21.
```

实际构造得到的 Maximal Clique 数量已经超过了猜想给出的上界，最终得到

```math
\boxed{f(7,3)\ge23>21=\psi(7,3).}
```

**23大于21。**

这一个仅包含7个顶点的具体反例，就足以否定 Tomescu 猜想。一个提出于45年前的组合数学猜想，由此被明确推翻。

小组研究还进一步表明，对于每个 $`d\ge6`$，都可以通过概率方法构造出违反 Tomescu 猜想的 hypergraph。

这说明，猜想的问题并非仅仅出现在某一个特殊参数下，而是其所依赖的规则分块结构并不具有普遍最优性。从一个具体的小规模反例，到更一般参数范围下的概率构造，这一探索进一步揭示了原有猜想的局限。

相关文件：[Maximal Cliques of hypergraphs.pdf](<研究成果/Tomescu 猜想/Maximal Cliques of hypergraphs.pdf>) · [deepseek研究记录.pdf](<研究成果/Tomescu 猜想/deepseek研究记录.pdf>)

## 同一场探索中的其他前沿成果

Tomescu 猜想的反例，是本次活动最具传播力的成果之一。与此同时，小组成员还探索了泛函分析、表示论、量子信息和特殊函数序列等方向。

### Martín 的 Banach 空间问题

在 Banach 空间理论中，DeepSeek 给出了一个肯定答案。

线性算子的范数可以理解为它对向量的最大放大比例。“范数取得”关心的是，这一上限能否在某个单位向量上真正实现。一个相关问题是，当空间缺少常用的几何条件时，是否仍能构造出秩为2的范数取得算子？

Martín 曾构造了一个 $`c_0`$ 的特定等价重范空间，其范数取得泛函集合不包含非平凡锥，使一个已有的充分条件无法直接使用。针对这一空间，研究给出了到欧几里得平面 $`\ell_2^2`$ 的秩二范数取得算子的明确构造，对 Martín 提出的相应问题给出了肯定答案。

这一结果说明，非平凡锥条件并不是这类算子存在的必要条件。它解决了上述特定空间的问题，一般 Banach 空间上的存在性问题仍有待研究。

相关文件：[DeepSeek秩二达范算子_论文稿.pdf](<研究成果/Martín 的 Banach 空间问题/DeepSeek秩二达范算子_论文稿.pdf>) · [DeepSeek数学能力测试研究报告.pdf](<研究成果/Martín 的 Banach 空间问题/DeepSeek数学能力测试研究报告.pdf>) · [报告相关研究文件](<研究成果/Martín 的 Banach 空间问题/报告相关研究文件/>)

### 对称群 $`S_n`$ 的不可约表示问题

在对称群表示论问题中，探索给出了关于 principal hook-length sequences 和极大维数表示的精确证书。

对称群 $`S_n`$ 的不可约表示，可以由整数 $`n`$ 的分拆来标记。研究要确定哪些分拆对应维数最大的表示。除了共轭分拆自然产生的等维情形，互不共轭的分拆是否也可能同时达到最大维数？

这次研究把极值搜索转化为 principal hook-length sequences 上的离散优化，并通过复核给出了精确的计算证书。在 $`1\le n\le350`$ 的范围内，每个 $`n`$ 恰有一个达到最大值的 principal hook-length sequence。结合固定序列下的极值结论，这意味着最大维数的分拆在共轭意义下唯一。

此外，对719对已列出的等维表示，研究都找到了维数严格更大的合法候选，从而排除了这些表示对同时成为全局最大者的可能。这些结果为“互不共轭的表示是否能够同时达到最大维数”这一问题提供了新的计算证据。对任意 $`n`$ 的统一结论仍待证明。

相关文件：[Q71_report.pdf](<研究成果/对称群S_n的不可约表示问题/Q71_report.pdf>) · [Q71_report_and_evidence](<研究成果/对称群S_n的不可约表示问题/Q71_report_and_evidence/>)

### 双参数量子信道的超收缩问题

在双参数 phase-covariant qubit channel 的超收缩问题中，探索给出了 $`q=4`$ 时 diagonal 方向的精确阈值，以及 coherence 方向必须满足的必要上界。

在此基础上，研究进一步提出一个尚待证明的猜想。**对单个量子比特，满足收缩不等式的参数区域可能具有矩形结构，即两个方向的约束能够同时刻画整个区域。**

如果这一猜想成立，将有望直接给出半群最优超收缩时间的精确表达式。

相关文件：[01分析小组-deepseek数学能力测试研究报告.pdf](<研究成果/双参数量子信道的超收缩问题/01分析小组-deepseek数学能力测试研究报告.pdf>) · [deepseek_test_memo_two_parameter_qubit.pdf](<研究成果/双参数量子信道的超收缩问题/deepseek_test_memo_two_parameter_qubit.pdf>)

### Trinomial cubic sums

在 trinomial cubic sums 问题中，探索严格确认了递推关系、比值包络和若干对数差分性质，同时发现了多个重要反例。

例如，对于多项式

```math
p=(x-1)(x-11)(x-20)
```

计算得到

```math
L(p^2)=-206,
```

这一结果排除了正 moment measure 存在的可能性。

此外，还发现

```math
S_{21}(0)>0,
```

从而直接否定了“对于所有 $`k\ge6`$，均有 $`S_k(0)\lt0`$”这一普遍断言。

相关文件：[deepmath06_trinomial_cubic_sums.pdf](<研究成果/Trinomial cubic sums/deepmath06_trinomial_cubic_sums.pdf>)

这些成果共同展示了 DeepSeek 在不同数学领域中进行构造、验证、反驳和推广的能力。从1981年的猜想到2026年的反例，AI X Math 社区与同济 DeepMath 团队举办的这次活动给出了一个清晰而有力的案例：

> **国产大模型已经能够在前沿数学问题中自主发现非平凡结构，并用可核验的结果推动数学研究向前一步。**

---

## 开源研究智能体

本仓库同时开源 **DeepMath 多 Agent 研究工作台**，让大家在浏览器中组织协同研究，并持续积累可复用的研究成果。

- **多 Agent 协作**：Controller 统筹目标、分配任务和审阅汇报，多个 Agent 按需配置职责、并行研究与交流；支持手动交互和自动推进。
- **研究资产管理**：将成果整理为资产，关联来源汇报与证据，保留历史版本，通过专题地图组织，并在多个项目中复用。
- **前端操作界面**：可视化管理项目与 Agent，开展对话、选择模型、查看运行过程和上下文 token 用量，操作研究资产及项目文件。

工作台在本机运行，需要 Node.js 24+、Codex CLI，以及自行配置的可用模型接口与 API Key。

**开始使用 → [智能体使用说明](workbench/README.md)**  
**模型设置 → [模型配置说明](workbench/MODEL_CONFIGURATION.md)**

代码采用 [MIT License](LICENSE)。

---

## 共创者

| 组别 | 姓名 / 称呼 | 学校 / 机构 |
| --- | --- | --- |
| 01 | Peijie Li | The University of Hong Kong |
| 01 | Yi Cheng | East China Normal University |
| 01 | Dier Tang | The University of Hong Kong |
| 03 | Jingzhao Zhang | Nanjing Normal University |
| 04 | Kangjian wu | Shanghai Normal University |
| 04 | Ziming Wang | Beijing University of Posts and Telecommunications |
| 05 | Xiongfeng Zhan | Beijing Jiaotong University |
| 05 | Ziyi Zhai |  |
| 06 | Emina | Hangzhou International Innovation Institute, Beihang University |
| 06 | Kevin | Nanyang Technological University |
| 07 | TZM | Huazhong University of Science and Technology |
| 07 | Yun Pu | AMSS, CAS |
| 09 | Dora | Shanghai Jiao Tong University |
| 09 | Kaichang Yu | Zhejiang University |
| 11 | hao yuan |  |
| 11 | Ruyu Huang | Academy of Mathematics and Systems Science, Chinese Academy of Sciences |
| 11 | Jiewen Wang | Zhejiang University |
| 11 | Cat.Jin | University of Cologne |
| 11 | Zhe Li | Xiamen University |

## 主办团队

Xiaoyang Chen, Qiaofeng Qu, Xiang Jiang, Zeren Zheng

---

## 加入社区

欢迎扫码加入 AI X Math 社区群。

<img src="assets/community-qr-20261112.jpg" alt="AI X Math 社区群二维码" width="400">

二维码有效期至 2026 年 11 月 19 日（以微信提示为准）。

### 合作与入群联系

如需合作或加入社区群聊，欢迎扫描下方二维码联系。

<img src="assets/contact-qr-20261112.jpg" alt="合作与社区群聊联系二维码" width="400">
