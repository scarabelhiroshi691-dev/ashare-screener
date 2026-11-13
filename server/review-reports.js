import { randomUUID } from "node:crypto";
import {
  buildReviewAnalysis,
  checkReviewIdentity,
  renderStageReport,
} from "./review-analysis.js";
import { ReviewFiles, hash } from "./review-files.js";
import { portable } from "./paths.js";

const days = [3, 5, 10];
const identityOf = (p) =>
  hash({
    baseline: p.baselineSignalDate,
    plans: p.frozenPlans,
    ids: p.initialTicketIds,
  });
export class ReviewReports {
  error = null;
  busy = false;
  constructor(
    daily,
    {
      files = new ReviewFiles(),
      now = () => new Date(),
      allowNewPlan = portable,
    } = {},
  ) {
    Object.assign(this, { daily, files, now, allowNewPlan });
  }
  async init() {
    try {
      this.plan = await this.files.readPlan();
      this.comparison = await this.files.readComparison();
      if (!this.plan && this.allowNewPlan) {
        if (this.data || (await this.files.readState()))
          throw Error("已有阶段登记但计划缺失，保留文件并停止生成");
        this.unconfigured = true;
        return;
      }
      this.unconfigured = false;
      if (
        !this.plan ||
        !days.every(
          (d) => this.plan.checkpoints?.filter((c) => c.day === d).length === 1,
        )
      )
        throw Error("原3/5/10计划不完整");
      checkReviewIdentity(this.daily.data, this.plan, this.comparison);
      const identity = identityOf(this.plan);
      const saved = await this.files.readState();
      if (saved) {
        if (
          saved.schema !== 1 ||
          saved.identity !== identity ||
          saved.stages?.length !== 3 ||
          !days.every(
            (d) => saved.stages.filter((s) => s.day === d).length === 1,
          ) ||
          saved.stages.some((s) => !this.validStage(s))
        )
          throw Error("报告登记格式或原计划身份异常");
        this.data = saved;
        for (const s of saved.stages)
          if (s.status !== "pending") await this.document(s.day);
      } else {
        const stages = [];
        for (const c of this.plan.checkpoints) {
          if (await this.files.readBundle(c.day))
            throw Error("已有报告快照但登记丢失，禁止重置通知状态");
          const old = c.report ? await this.files.legacy(c.day) : null;
          stages.push({
            day: c.day,
            status: old ? "legacy" : "pending",
            asOf: c.asOf || null,
            dueDate: c.dueDate || null,
            preparedAt: c.reportPreparedAt || null,
            report: old?.file || null,
            reportHash: old?.sha256 || null,
            delivery: {
              status: old ? "legacy-recorded" : "none",
              basis: old
                ? "沿用原checkpoint.report和项目已交付记录；不推定实际送达时间"
                : null,
            },
          });
        }
        await this.commit({ schema: 1, identity, stages });
      }
    } catch (e) {
      this.error = e.message;
    }
  }
  validStage(s) {
    const d = s.delivery;
    if (!d) return false;
    if (s.status === "pending") return d.status === "none" && !s.report;
    if (!s.report || !/^[a-f0-9]{64}$/.test(s.reportHash || "")) return false;
    if (s.status === "legacy") return d.status === "legacy-recorded";
    return (
      s.status === "prepared" &&
      /^[a-f0-9]{64}$/.test(s.bundleHash || "") &&
      ["pending", "claimed", "delivered"].includes(d.status) &&
      (d.status === "pending" ||
        (typeof d.token === "string" &&
          Number.isFinite(Date.parse(d.claimedAt)))) &&
      (d.status !== "delivered" ||
        (Number.isFinite(Date.parse(d.deliveredAt)) && !!d.receipt))
    );
  }
  async commit(next) {
    try {
      await this.files.writeState(next);
      this.data = next;
    } catch (e) {
      this.error = `报告登记保存失败：${e.message}；未确认交付，禁止继续通知`;
      throw e;
    }
  }
  analysis() {
    if (!this.plan) throw Error("阶段计划未加载");
    return buildReviewAnalysis(
      this.daily.committed || this.daily.data,
      this.plan,
      this.daily.calendarReview(),
      this.comparison,
    );
  }
  state() {
    let analysis = null,
      error = this.error;
    try {
      analysis = this.unconfigured ? null : this.analysis();
    } catch (e) {
      error = e.message;
    }
    const calendar = this.daily.calendarReview();
    return {
      error,
      busy: this.busy,
      notice: this.unconfigured
        ? "启用固定模拟并完成首个有入选信号的复盘后，会建立本实例独立的3/5/10交易日阶段计划。"
        : null,
      analysis,
      calendar: {
        asOf: calendar.asOf,
        count: calendar.count,
        exact: calendar.exact,
        missed: calendar.missed,
        incomplete: calendar.incomplete,
        unverified: calendar.unverified,
      },
      stages: (this.data?.stages || []).map((s) => ({
        ...s,
        delivery: {
          status: s.delivery.status,
          token: s.delivery.status === "claimed" ? s.delivery.token : undefined,
          claimedAt: s.delivery.claimedAt,
          deliveredAt: s.delivery.deliveredAt,
          receipt: s.delivery.receipt,
          basis: s.delivery.basis,
        },
        dueDate:
          s.dueDate ||
          (calendar.exact ? calendar.confirmedDates[s.day - 1] || null : null),
        due: calendar.exact && calendar.count >= s.day,
        url: s.report ? `/api/daily/reports/file?day=${s.day}` : null,
        snapshotUrl:
          s.status === "prepared"
            ? `/api/daily/reports/file?day=${s.day}&format=json`
            : null,
      })),
      notificationRule:
        "报告已准备不等于聊天已送达；领取后中断需核对聊天再确认或释放，不自动重复通知。原计划只读，新节点登记由应用唯一写入。",
    };
  }
  async refresh() {
    if (this.unconfigured && !this.error && !this.busy && !this.daily.active) {
      const ledger = this.daily.committed || this.daily.data;
      const firstDate = ledger.tickets.map((t) => t.signalDate).sort()[0];
      const firstDay = ledger.days.find((d) => d.date === firstDate);
      if (
        !firstDay ||
        firstDay.plans.some((p) => p.items.some((i) => i.state === "pending"))
      )
        return;
      this.busy = true;
      try {
        await this.files.initializePlan({
          baselineSignalDate: firstDate,
          frozenPlans: structuredClone(ledger.plans),
          initialTicketIds: ledger.tickets
            .filter((t) => t.signalDate === firstDate)
            .map((t) => t.id),
          checkpoints: days.map((day) => ({ day, report: null })),
          createdAt: this.now().toISOString(),
        });
        await this.init();
        await this.daily.calendar?.loadPlan();
      } catch (e) {
        this.error = `独立阶段计划未完成：${e.message}`;
      } finally {
        this.busy = false;
      }
    }
    if (
      this.busy ||
      this.error ||
      !this.data ||
      this.daily.active ||
      this.daily.calendar?.active ||
      this.daily.scheduler?.pendingExecution ||
      this.daily.storage?.status().blocked ||
      this.daily.scheduler?.decision()?.task
    )
      return;
    this.busy = true;
    try {
      const calendar = this.daily.calendarReview();
      if (!calendar.exact || calendar.planError || calendar.cacheError) return;
      if (identityOf(await this.files.readPlan()) !== this.data.identity)
        throw Error("原计划身份变化，停止阶段生成");
      checkReviewIdentity(this.daily.data, this.plan, this.comparison);
      for (const stage of this.data.stages) {
        if (stage.status !== "pending" || calendar.count < stage.day) continue;
        const ledger = structuredClone(this.daily.committed || this.daily.data);
        const analysis = buildReviewAnalysis(
          ledger,
          this.plan,
          calendar,
          this.comparison,
        );
        const payload = {
          schema: 1,
          identity: this.data.identity,
          day: stage.day,
          dueDate: calendar.confirmedDates[stage.day - 1],
          preparedAt: this.now().toISOString(),
          analysis,
          calendar: structuredClone(calendar),
          ledger,
        };
        payload.markdown = renderStageReport(payload);
        const bundle = await this.files.bundle(stage.day, payload);
        if (
          bundle.identity !== this.data.identity ||
          bundle.day !== stage.day ||
          !bundle.calendar.exact ||
          bundle.calendar.count < stage.day ||
          bundle.dueDate !== bundle.calendar.confirmedDates[stage.day - 1]
        )
          throw Error("阶段快照与计划或交易日证据不一致");
        const report = await this.files.markdown(stage.day, bundle.markdown);
        const next = structuredClone(this.data),
          entry = next.stages.find((s) => s.day === stage.day);
        Object.assign(entry, {
          status: "prepared",
          report,
          reportHash: hash(bundle.markdown),
          bundleHash: hash(bundle),
          asOf: bundle.analysis.asOf,
          dueDate: bundle.dueDate,
          preparedAt: bundle.preparedAt,
          delivery: { status: "pending" },
        });
        await this.commit(next);
      }
    } catch (e) {
      this.error ||= `阶段报告未完成：${e.message}`;
    } finally {
      this.busy = false;
    }
  }
  async document(day, format = "md") {
    if (!days.includes(day) || !["md", "json"].includes(format))
      throw Error("无效报告请求");
    const stage = this.data?.stages.find((s) => s.day === day);
    if (!stage || stage.status === "pending") throw Error("阶段报告尚未准备");
    if (stage.status === "legacy") {
      if (format === "json") throw Error("旧报告保留原文件，没有新版快照");
      const old = await this.files.legacy(day);
      if (old.sha256 !== stage.reportHash)
        throw Error("旧报告内容变化，请核验后处理");
      return old.text;
    }
    const b = await this.files.readBundle(day);
    if (
      !b ||
      hash(b) !== stage.bundleHash ||
      hash(b.markdown) !== stage.reportHash
    )
      throw Error("阶段快照缺失或校验失败");
    return format === "json" ? JSON.stringify(b, null, 2) : b.markdown;
  }
  async notification(action, input) {
    if (this.busy || this.error || !this.data)
      throw Error(this.error || "报告正在保存，请稍后");
    if (!days.includes(input?.day)) throw Error("无效节点");
    this.busy = true;
    try {
      const next = structuredClone(this.data),
        stage = next.stages.find((s) => s.day === input.day),
        delivery = stage.delivery;
      if (stage.status !== "prepared")
        throw Error("只能领取新准备的报告，旧报告不重复通知");
      await this.document(input.day);
      if (action === "claim") {
        if (delivery.status !== "pending")
          throw Error("报告已领取或已通知；请先核对聊天交付记录，不能重复领取");
        Object.assign(delivery, {
          status: "claimed",
          token: randomUUID(),
          claimedAt: this.now().toISOString(),
        });
      } else if (["ack", "release"].includes(action)) {
        if (!input.token || input.token !== delivery.token)
          throw Error("通知凭据不匹配");
        if (
          typeof input.receipt !== "string" ||
          input.receipt.trim().length < 8 ||
          input.receipt.length > 500
        )
          throw Error("请提供已实际交付或已核对聊天未送达的依据");
        if (action === "ack" && delivery.status === "delivered")
          return {
            day: stage.day,
            status: "delivered",
            deliveredAt: delivery.deliveredAt,
          };
        if (delivery.status !== "claimed") throw Error("通知尚未领取");
        if (action === "ack")
          Object.assign(delivery, {
            status: "delivered",
            deliveredAt: this.now().toISOString(),
            receipt: input.receipt.trim(),
          });
        else {
          stage.delivery = {
            status: "pending",
            lastRelease: {
              claimedAt: delivery.claimedAt,
              at: this.now().toISOString(),
              reason: input.receipt.trim(),
            },
          };
        }
      } else throw Error("无效通知操作");
      await this.commit(next);
      return {
        day: stage.day,
        ...stage.delivery,
        report: stage.report,
        url: `/api/daily/reports/file?day=${stage.day}`,
        reportHash: stage.reportHash,
      };
    } finally {
      this.busy = false;
    }
  }
}
