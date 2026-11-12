# 45年猜想，7个顶点：DeepSeek自主突破组合数学难题

## AI X Math 社区 × 同济 DeepMath 团队，公开探索国产大模型的数学能力边界

如果一个数学猜想悬置了45年，国产大模型能否找到突破口？

这一次，答案是一组可以独立核验的数学对象：

> **DeepSeek 找到了一个只有7个顶点的反例，用23个极大团击穿了 Tomescu 猜想预测的21个。**

这一成果来自 **AI X Math 社区** 发起、**同济 DeepMath 团队** 提供智能体系统与 DeepSeek API 支持的前沿数学探索活动。

活动面向10个数学小组展开，参与者均为数学专业研究生及以上学历。每个小组围绕一个尚无已知完整解答的数学问题，在24小时内集中攻坚探索，最终由人工核验数学结果。

在 Tomescu 猜想这一任务中，人工只提供原始问题并启动系统，没有提供关键构造、证明思路或中途提示。DeepSeek 自主完成了问题分析、构造搜索和反例发现，研究者随后对结果进行数学核验。

这正是本次活动希望公开回答的问题：

> **国产大模型能否真正进入前沿数学研究现场？**

## 一个提出于1981年的猜想

1965年，Moon 和 Moser 解决了普通图中极大团数量的最大值问题。1981年，Tomescu 将这一问题推广到一致超图，猜想一类具有规则分块结构的超图，能够达到极大团数量的最大值。

设 $`f(n,d)`$ 表示 $`n`$ 个顶点的 $`d`$-一致超图中极大团的最大数量。Tomescu 猜想

```math
f(n,d)=\psi(n,d),
\qquad
\psi(n,d)=
\max_{n_1+\cdots+n_k=n}
\prod_i\binom{n_i}{d-1}.
```

这里的“团”是一个顶点集合，其中任意 $`d`$ 个顶点都构成超边；“极大团”则是已经无法再加入其他顶点的团。

这个猜想延续了经典图论中的结构直觉：通过精心设计的分块方式，可以产生大量极大团。它长期被视为一致超图极值理论中关于极大团计数的核心问题之一。

## 7个顶点上的23个极大团

DeepSeek 找到的反例非常具体。

在顶点集 $`[7]=\{1,\ldots,7\}`$ 上，取12个三元组

```math
\begin{aligned}
F=\{&
123,145,246,127,156,346,\\
&137,467,235,237,257,357
\}.
\end{aligned}
```

令

```math
H(3,7)=\binom{[7]}3\setminus F.
```

7个顶点一共有

```math
\binom73=35
```

个三元组，因此 $`H(3,7)`$ 有

```math
35-12=23
```

条超边。

这个构造的关键性质是：

> **任意4个顶点都至少包含 $`F`$ 中的一个三元组。**

因而，$`H(3,7)`$ 不存在4顶点团。于是，$`H(3,7)`$ 的每一条超边都无法继续扩展，全部都是极大团。

因此

```math
f(7,3)\ge23.
```

而 Tomescu 猜想给出的数值是

```math
\psi(7,3)=21.
```

最终得到

```math
\boxed{f(7,3)\ge23>21=\psi(7,3).}
```

23大于21，意味着这个提出于45年前的猜想被明确推翻。

小组研究还进一步表明：对于每个 $`d\ge6`$，都可以通过概率方法构造出违反 Tomescu 猜想的超图。这说明问题并非只在某一个小参数上出现异常，而是揭示了猜想所依赖的整体结构并不具有普遍最优性。

相关文件：[Maximal Cliques of hypergraphs.pdf](<研究成果/Tomescu 猜想/Maximal Cliques of hypergraphs.pdf>) · [deepseek研究记录.pdf](<研究成果/Tomescu 猜想/deepseek研究记录.pdf>)

## 同一场探索中的其他前沿成果

Tomescu 猜想的反例，是本次活动最具传播力的成果之一。与此同时，小组成员还探索了泛函分析、表示论、量子信息和特殊函数序列等方向。

### Martín 的 Banach 空间问题

DeepSeek 给出了肯定答案：即使某个 $`c_0`$ 的等价赋范空间，其范数取得泛函不包含非平凡锥，仍然可以构造到欧几里得平面 $`\ell_2^2`$ 的秩二范数取得算子。

这个结果同时说明，“存在非平凡锥”并不是秩二范数取得算子存在的必要条件。

相关文件：[DeepSeek秩二达范算子_论文稿.pdf](<研究成果/Martín 的 Banach 空间问题/DeepSeek秩二达范算子_论文稿.pdf>) · [DeepSeek数学能力测试研究报告.pdf](<研究成果/Martín 的 Banach 空间问题/DeepSeek数学能力测试研究报告.pdf>) · [报告相关研究文件](<研究成果/Martín 的 Banach 空间问题/报告相关研究文件/>)

### 对称群 $`S_n`$ 的不可约表示问题

探索给出了关于主钩长序列和极大维数表示的精确证书。

对 $`1\le n\le350`$ 的范围核验表明，每个 $`n`$ 都只有一个达到最大维数的主钩长序列；719个已知等维表示对也都找到了严格更大的合法候选。

这些计算结果为“互不共轭的表示是否能够同时达到最大维数”提供了新的证据。

相关文件：[Q71_report.pdf](<研究成果/对称群S_n的不可约表示问题/Q71_report.pdf>) · [Q71_report_and_evidence](<研究成果/对称群S_n的不可约表示问题/Q71_report_and_evidence/>)

### 双参数量子信道的超收缩问题

在双参数 phase-covariant qubit channel 的超收缩问题中，探索分别识别出了 diagonal 方向和 coherence 方向的临界阈值，并提出单点收缩区域为矩形的猜想。

这个猜想若成立，将直接给出半群最优超收缩时间的精确表达式。

相关文件：[01分析小组-deepseek数学能力测试研究报告.pdf](<研究成果/双参数量子信道的超收缩问题/01分析小组-deepseek数学能力测试研究报告.pdf>) · [deepseek_test_memo_two_parameter_qubit.pdf](<研究成果/双参数量子信道的超收缩问题/deepseek_test_memo_two_parameter_qubit.pdf>)

### Trinomial cubic sums

在 trinomial cubic sums 问题中，探索严格确认了递推关系、比值包络和若干对数差分性质，同时发现了多个重要反例。

例如，对

```math
p=(x-1)(x-11)(x-20)
```

有

```math
L(p^2)=-206,
```

从而排除了正 moment measure 的存在；此外，$`S_{21}(0)>0`$ 直接否定了“对所有 $`k\ge6`$，都有 $`S_k(0)<0`$”这一普遍断言。

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

Xiaoyang Chen, Qiaofeng Qu, Jiang Xiang, Zeren Zheng

---

## 加入社区

欢迎扫码加入 AI X Math 社区群。

<img src="assets/community-qr-20261112.jpg" alt="AI X Math 社区群二维码" width="400">

二维码有效期至 2026 年 11 月 19 日（以微信提示为准）。
