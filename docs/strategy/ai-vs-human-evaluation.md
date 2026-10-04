# AI vs human evaluation of candidates: what the research says

Short version: **human screening is noisy and measurably biased, and so are LLMs.** The defensible claim is not "AI is unbiased". It is this: **structured, criterion-by-criterion scoring with evidence is more consistent than ad-hoc judgement, it can be audited, and a person keeps the decision.**

## Humans: noisy and biased

- **Noise.** Kahneman, Sibony and Sunstein (*Noise*, 2021) report that two interviewers who saw the same candidate disagree about who is better roughly a quarter of the time. If all you know is that candidate A impressed one interviewer more than B, the chance A is really stronger is only **56–61%** ([Recruiting News Network](https://www.recruitingnewsnetwork.com/posts/whats-broken-about-the-job-interview), [SBAM summary](https://www.sbam.org/noisy-job-interviews/)).
- **Structure beats intuition.** Sackett et al. (2022, *Journal of Applied Psychology*) revisited Schmidt & Hunter (1998). **Structured interviews** have the highest operational validity of common selection methods, **about 0.42 vs 0.19 for unstructured** interviews ([TestGorilla summary](https://www.testgorilla.com/blog/hiring-tools-validity-revisited/), [SIOP](https://www.siop.org/tip-article/is-cognitive-ability-the-best-predictor-of-job-performance)).
- **Discrimination is persistent.** A meta-analysis of 28 field experiments (Quillian et al., *PNAS* 2017; 55,842 applications) found white applicants received **36% more callbacks** than equally qualified African Americans, with **no decline since 1989** ([PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5642692/)).
- **Speed over substance.** Recruiters spend about **7.4 seconds** on an initial resume scan (Ladders eye-tracking study, 2018) ([HR Dive](https://www.hrdive.com/news/eye-tracking-study-shows-recruiters-look-at-resumes-for-7-seconds/541582/)).

## LLMs: also biased, in different ways

- **Name bias in ranking.** Bloomberg (2024) asked GPT-3.5 to rank otherwise identical resumes 1,000 times. Resumes with names associated with Asian women ranked first **17.2%** of the time and Black men **7.6%**, against a parity rate of 12.5% ([Bloomberg's data](https://github.com/BloombergGraphics/2024-openai-gpt-hiring-racial-discrimination), [FlowingData](https://flowingdata.com/2024/03/13/racial-bias-in-openai-gpt-resume-rankings)).
- **Large-scale audit.** Wilson & Caliskan (University of Washington, AIES 2024) tested three open models on 554 resumes × 571 job descriptions with names swapped. The models preferred **white-associated names 85%** of the time, and Black men fared worst ([UW News](https://www.washington.edu/news/2024/10/31/ai-bias-resume-screening-race-gender/)).
- **Bias can flip direction.** An et al. (*PNAS Nexus*, 2025) and follow-ups found a **pro-female** bias across current models. **Removing the name** removed nearly all of it, while asking the model to "be neutral" did almost nothing ([arXiv follow-up](https://arxiv.org/pdf/2606.18649)).
- **Rubrics matter.** With a structured rubric, LLM-human agreement can match human-human agreement. In one study, adding GPT-4o as a fifth rater to four instructors moved the ICC from 0.88 to 0.89. Agreement is weakest on borderline cases ([arXiv 2604.12227](https://arxiv.org/pdf/2604.12227)). In another benchmark, a structured rubric raised the LLM judge's correlation with human experts from **0.20 to 0.63** ([arXiv 2604.05912](https://arxiv.org/pdf/2604.05912)).

## What RentRecruiter does with this

| Risk | What we do |
|---|---|
| Name and demographic bias | The agent scores **criteria against the scout's notes**, never a whole-resume "vibe" ranking. Planned: strip names and photos before scoring (the most effective mitigation in the literature). |
| Inconsistency (noise) | The same weighted criteria for every candidate. Each criterion gets one verdict (MET / PARTIAL / NOT_MET / UNKNOWN) and **the score is computed by code**, not chosen by the model. |
| Black-box decisions | Every verdict quotes the evidence line from the notes. "Unknown" is a valid answer, so missing information isn't counted as a "no". |
| Automation without oversight | The **company decides**. The agent recommends and pays only within on-chain limits. This matches the EU AI Act, where recruitment AI is high-risk and needs human oversight. |
| Hidden drift | Roadmap: log verdicts per criterion and run periodic name-swap audits (the Bloomberg/UW method) on our own pipeline, published per model version. |

## Framing for the pitch

> "Ludzie oceniają kandydatów niespójnie: dwóch rekruterów nie zgadza się co czwarty raz, a dyskryminacja w CV-screeningu nie spadła od 30 lat. Modele też mają biasy. Dlatego nie pytamy AI «czy ten kandydat jest dobry», tylko «czy spełnia kryterium X, i gdzie to jest napisane». Wynik liczy kod, decyzję podejmuje człowiek, a bias mierzymy, zamiast udawać, że go nie ma."

Avoid: "AI is less biased than humans" as a blanket claim. The evidence doesn't support it in general. It supports *structured* evaluation, whoever does it.
