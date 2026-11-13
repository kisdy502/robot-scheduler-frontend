# 机器人调度系统 Java 重构方案

> 版本 v1.0 · 基于对 `robot-scheduler-rest-api`、`rmf-qc-fleet-adapter`、`open-rmf` 三仓源码全量调研，以及对 `D:\workspace\qc-robot` 成熟 Java 架构的依赖/工程实践调研。

---

## 1. 现状盘点

### 1.1 现有架构（4 个运行时进程 + DDS 总线）

```
taskflow-management-service (上层业务, 8086)
        │ HTTP (18 个 REST 端点, 0.2.0)
        ▼
┌─────────────────────────────┐
│ robot-scheduler-rest-api    │  FastAPI + rclpy
│ (0.0.0.0:8090)              │  任务记录/查询/快照/预检
└──────────┬──────────────────┘
           │ ROS2 DDS (ROS_DOMAIN_ID=42)
           ▼
┌───────────────────────────────────────────────┐
│ RMF Core (C++)                                 │
│  rmf_traffic_schedule / blockade / dispatcher  │
│  door_supervisor / lift_supervisor             │
│  mutex_group_supervisor / reservation_node     │
│  charger_pool_manager (robot_scene_charger_pool)│
└──────────┬────────────────────────────────────┘
           │ rmf_adapter (C++ bindings, easy_full_control)
           ▼
┌─────────────────────────────┐
│ rmf-qc-fleet-adapter (Python)│  机器人状态轮询/命令下发/取消停机
└──────────┬──────────────────┘
           │ HTTP (8 个端点)
           ▼
   RMS (robot-management-service :18083)
           │
           ▼
      机器人本体
```

### 1.2 核心痛点

| 痛点 | 说明 |
|---|---|
| 进程多、链路长 | 一次任务下发要穿越 rest-api → DDS → dispatcher → 竞标 → adapter → bindings → HTTP → RMS，排障困难 |
| C++/Python/DDS 技术栈重 | RMF 编译部署复杂，`rmf_adapter` C++ bindings 难以维护和扩展 |
| 分布式协商复杂度高 | 时空轨迹冲突检测 + Table 协商，但实际场景（单层平面、机器人本体自带避障）用不到如此强的能力 |
| 大量模块闲置 | door/lift supervisor、traffic_editor、Gazebo 仿真、RViz 可视化、rmf-web、delivery/clean/patrol 任务类型均未使用 |
| 状态在内存/JSON 文件 | 任务记录存 `/tmp/*.json` + `.archive.jsonl`，无数据库，无高可用 |

### 1.3 现有系统实际用到的能力（调研结论，重构必须保留）

1. **18 个 REST 端点**（字段需一模一样，见 §6）
2. **RMS 8 个 HTTP 端点**（inventory / status / navigate / start-activity / stop / pause-task / resume-task / completions-ack）
3. **任务类型**：`go_to_place`、`quality_inspection`、`charge`、`swap_battery`、`return_home`、`pause_task`/`resume_task`（compose）、`cache_task_context`；不支持 `teleop`/`delivery_pickup`/`delivery_dropoff`
4. **调度语义**：指定 robot（`robot_task_request`）或自动分配（`dispatch_task_request`）；优先级、`earliest_start_time`、任务取消（fork 定制：活动任务取消发 `completed` + `cancellation` 标记）
5. **机器人管理**：1Hz 状态轮询 + 0.1Hz inventory 轮询、15s stale 下线（decommission）、位置吸附校验（max_merge_waypoint_distance=3.0m）、命令重试（3 次退避 1s）、每机器人命令串行、活动任务取消触发机器人 stop
6. **充电桩池**：allocate/release/list + compatible_chargers + resource_type(charger/swap_station)
7. **交通约束**：lane 开闭、限速、互斥组（本项目地图实际使用情况待确认，先保留 lane 级约束）
8. **状态广播契约**：`task_state_update` JSON（booking.id / status: queued|underway|completed|failed|killed|canceled / detail / cancellation / assigned_to{group,name}）——新系统内部事件沿用此结构
9. **场景资源**：points/chargers/homes/standby_areas/transforms/nav_graph 六类 JSON + scene_code/bundle_version
10. **任务记录生命周期**：published → rmf_response_received（保留字段名）→ cancel_requested；终态 {completed,failed,canceled}；TTL 10s、abandon 1800s、终态保留 7200s、归档

---

## 2. 重构目标与范围

| # | 目标 | 验收标准 |
|---|---|---|
| 1 | REST API 完全兼容 | 18 端点路径/方法/请求/响应字段与现网一致；旧 `test_rest_api.py`（4079 行）的行为断言转为 Java 契约测试全部通过 |
| 2 | RMS HTTP 客户端 | 复刻 8 端点调用语义（超时/重试/三态映射/每机器人串行） |
| 3 | 简化调度内核替代 RMF | 单进程 Java 实现：拓扑图、路径规划、资源互斥、集中任务分配、任务执行状态机、电量与充电管理；**去除** ROS2/DDS/C++、分布式协商、门/电梯、仿真/可视化 |
| 4 | 数据持久化 | 任务/资源入 PostgreSQL，运行态入 Redis，场景 bundle 入 S3(MinIO)——对齐 qc-robot 工程规范 |
| 5 | 部署简化 | 4 进程 + DDS → 1 个 Spring Boot 服务（可水平扩展受限于内核单主，见 §11） |

**不在范围内**：上层 taskflow 编排（不动）、RMS 本体（不动）、机器人本体导航（RMS 负责，内核只发目标点）。

---

## 3. 总体架构

### 3.1 目标架构（单体多模块，微服务化预留）

```
taskflow-management-service (不变)
        │ HTTP REST (18 端点, 字段一模一样)
        ▼
┌──────────────────────────────────────────────────────────────┐
│  robot-scheduler-service (Spring Boot 3.3.5, Java 21)          │
│                                                                │
│  scheduler-api            REST 兼容层 (18 端点 + 契约测试)      │
│  scheduler-core           调度内核 (内存态, 替代 RMF)            │
│   ├─ graph       拓扑图: nav_graph.yaml → TopologyGraph        │
│   ├─ planner     路径规划: JGraphT Dijkstra/A* + 时间估算       │
│   ├─ traffic     资源占用表: lane/waypoint 互斥 + 互斥组         │
│   ├─ task        任务模型: Phase 序列 + 状态机 + 事件总线        │
│   ├─ assign      集中式分配器 (BatteryAware 代价)               │
│   ├─ fleet       机器人管理: 轮询/上下线/吸附校验/命令执行器       │
│   └─ charger     充电桩池: allocate/release/list               │
│  scheduler-rms-client     RMS HTTP 客户端 (8 端点, 熔断重试)     │
│  scheduler-persistence    MyBatis-Plus + Flyway (PG16)         │
│  scheduler-common         基础协议 (Result/envelope/DTO/错误码) │
└───────┬──────────────┬──────────────┬────────────────────────┘
        │              │              │
   PostgreSQL 16     Redis 7      MinIO(S3)
   任务/资源/审计      运行态镜像/锁   nav_graph/场景bundle/归档
        │
        │ HTTP (inventory/status 轮询 + navigate/start-activity/stop...)
        ▼
   RMS (robot-management-service) → 机器人
```

**为什么单体而不是微服务**：调度内核（机器人状态、资源占用表、任务队列）是强内存态、低延迟要求（状态 1Hz、任务响应秒级）的组件；RMF 拆成多进程是历史包袱（DDS 通讯、分布式协商），集中式单进程反而更简单可靠。模块间用 Spring 事件总线解耦，将来如需拆分（如 API 层独立扩展），可将 `scheduler-api` 与 `scheduler-core` 按 §3.3 拆两服务 + Redis pub/sub 同步快照。

### 3.2 Maven 模块结构

```
robot-scheduler/  (parent: robot-scheduler-parent, ${revision} 版本管理)
├── scheduler-common/          # 协议层: ApiEnvelope/DTO/错误码/枚举/常量(对齐旧 constants.py)
├── scheduler-core/            # 调度内核(纯 Java, 不依赖 Web, 可单测)
├── scheduler-rms-client/      # RMS 客户端(接口 + 默认 HTTP 实现 + Mock 实现)
├── scheduler-persistence/     # 实体/Mapper/Flyway 迁移
├── scheduler-api/             # Controller/全局异常/OpenAPI/装配
└── scheduler-boot/            # 启动装配(application.yml/Dockerfile)
```

### 3.3 微服务化预留方案（可选后置）

- 拆分点：`scheduler-api`（无状态，N 副本）+ `scheduler-core`（单主，Redis 租约选主，参考 qc-robot `RedisLeaseLockService`）
- 同步：快照类接口走 Redis 镜像（§8.2 的 key 结构），命令类走 HTTP internal 接口
- 本期不实施，仅保证模块边界干净（core 不依赖 web）

---

## 4. 技术栈选型（对齐 qc-robot 基线）

| 层 | 选型 | 版本 | 来源对照 |
|---|---|---|---|
| 语言/运行时 | Java | 21 | robot-platform-parent |
| 框架 | Spring Boot | 3.3.5 | 同上 |
| ORM | MyBatis-Plus（spring-boot3-starter） | 3.5.7 | robot-common-mybatis |
| 数据库 | PostgreSQL + Flyway（独立 `-flyway` 模块） | 16 / 10.x | qc-robot 每服务一库 + 独立迁移模块 |
| 缓存/锁 | spring-data-redis（Lettuce）+ Redisson（分配器/充电桩分布式锁） | Boot 管理 / 3.29.0 | 权限缓存 + RLock 模式 |
| 对象存储 | AWS SDK v2 S3（robot-common-storage 同款，MinIO 做 S3 网关） | 2.25.x | ceph-storage 模式 |
| HTTP 客户端 | Spring RestClient + spring-retry / Resilience4j 熔断 | — | third-party-starter 的 RfsmSchedulerClient 模式 |
| 图算法 | **JGraphT**（Dijkstra/A*/KShortestPath） | 1.5.2 | 新增，用于拓扑规划 |
| 接口文档 | springdoc-openapi-starter-webmvc-ui | 2.6.0 | robot-common-web |
| 工具 | Lombok + MapStruct + easyexcel（报表预留） | 1.18.34/1.5.5 | 同上 |
| 测试 | JUnit5 + Testcontainers(PG) + H2(内核单测) + awaitility | 1.20.4 | qc-robot 测试栈 |
| 可观测 | actuator + micrometer-prometheus + OTel(OTLP→Tempo) | — | 同上 |
| 配置中心 | Nacos（可选，本地 profile 直配） | 2023.0.1.2 | 同上 |
| 认证 | 本期沿用内部调用（默认放行），预留 robot-common-security JWT | — | 调度接口为内网机器调用 |

**复用 qc-robot 的方式**：`scheduler-common` 直接依赖 `robot-common-core/web/mybatis/storage`（版本 0.1.5-ZJ-SNAPSHOT，私服已有），获得 `Result/PageResult/ErrorCode/BusinessException/GlobalExceptionHandler/BaseEntity/雪花ID/审计填充`。旧接口 envelope 与 `Result` 的差异在 `scheduler-api` 内做适配（§6.2）。

---

## 5. 调度内核设计（简化 RMF）

### 5.1 RMF 模块 → 新内核映射表（核心决策）

| RMF 模块 | 处置 | 新实现 | 理由 |
|---|---|---|---|
| `rmf_traffic/agv/Graph`（拓扑图） | **保留(简化)** | `TopologyGraph`：waypoint(map,x,y,name,holding/passthrough/parking/charger,mutexGroup) + lane(entry,exit,speedLimit,event,mutexGroup) + nav_graph.yaml(0.yaml) 解析器 | 一切调度的基础 |
| `rmf_traffic/agv/Planner`（时空 A*+运动学插值+双层启发式缓存） | **简化** | JGraphT 加权图：lane 权重 = 长度/限速 + 事件耗时；Dijkstra 求拓扑最短路；匀速模型估算 ETA（不做差速运动学样条插值）；输出 waypoint 序列 + 预计时间 | 实际导航由 RMS/机器人执行，内核只做拓扑级规划与时间估算；运动学精度对本场景收益低 |
| `rmf_traffic/schedule`（Database/Participant/Mirror/Patch，时空轨迹预约） | **重构** | 进程内 `TrafficRegistry`：waypoint/lane 粒度占用表 `Map<nodeId, Occupier>` + 互斥组表 + 到达释放（reached） | RMF 用连续时空轨迹+冲突检测是"精确但复杂"；离散资源占用是"近似但简单可靠"，匹配本项目单层平面场景 |
| `rmf_traffic/schedule/Negotiation` + `SimpleNegotiator`（分布式层级协商） | **去除** | 集中式处理：规划时把被占资源视为不可通行，不可达则按优先级（任务优先级>剩余电量>等待时长）触发低优先级机器人"让路"（导航至最近 holding_point 等待重规划），即 `CentralizedNegotiation` 的贪心简化 | 单进程内无需协商协议；让路点机制简单且可解释 |
| `rmf_traffic/blockade`（交通灯分段放行） | **去除** | 资源占用表 + 机器人到达回报（RMS status 中的位置吸附判定） | 机器人本体有避障，执行期兜底简化 |
| `rmf_task`（Task/Description/Model/Phase/State） | **保留(简化)** | `TaskDefinition`(category+参数) + `RobotSnapshot`(waypoint,orientation,batterySoc,dedicatedCharger,idle) + `estimateFinish()`（travel estimator + phase 时长表 + 电量推演） | `Model::estimate_finish` 是分配优化的关键抽象，保留 |
| `rmf_task/TaskPlanner`（greedy/A* 分配 + BatteryAware 代价） | **保留(简化)** | `TaskAssigner`：贪心分配（候选 = 该 fleet 可派机器人 × 每人 estimateFinish 代价），代价 = 完成时间 + 电量惩罚(低SOC二次惩罚) + 繁忙惩罚；电量不足以返充 → 剔除候选 | 集中式后无需 bidding/竞标往返 |
| `rmf_task_ros2/Dispatcher + Auctioneer 竞标` | **简化** | 进程内 `Dispatcher`：submit/cancel + 状态机 + 分配触发（任务到达、机器人空闲、状态变更三个触发点） | 同上 |
| `rmf_fleet_adapter`（full_control：TaskManager/Phases/Negotiator/FindPath） | **重构** | `TaskExecutor`：按 Phase 序列执行（GoToPlace→PerformAction→ReturnHome），Phase 完成依赖 RMS completed_commands 回执 | 逻辑从 Python adapter 移植 |
| `rmf_fleet_adapter`（RobotCommandHandle/EasyFullControl 回调） | **重构** | `RobotHandle`：navigate/stop/executeAction 三命令 + finished/error/identifier 语义 + 命令重试/串行/generation 取消 | 逐条移植 robot_handle.py 语义 |
| `charger_pool_manager` | **保留** | `ChargerPoolService`：DB 为正本 + 内存缓存 + Redisson 锁保证多实例下 allocate 原子性 | robot_scene_charger_pool 对等实现 |
| `rmf_reservation_node`（FIFO 目的地排队） | **简化** | 目的地被占 → 任务保持 queued，周期重试；互斥组覆盖窄区 | 默认关闭的节点，能力被占用表覆盖 |
| door/lift supervisor、mutex_group_supervisor 独立节点 | 去除/吸收 | 门/电梯：去除（地图无门梯）；mutex group 吸收进 `TrafficRegistry` | — |
| `rmf_traffic_editor`/Gazebo 仿真/RViz/rmf-web/websocket/broadcast | **去除** | 状态查询走 REST（现有轮询模式） | — |
| read_only adapter、traffic-light 模式、 dispenser/ingestor/workcell、delivery/loop/patrol/clean 任务 | **去除** | — | 未使用 |
| `rmf_battery`（功率积分） | **简化** | 线性模型：运动耗电率(W·h/m) + 待机耗电率 + 充电速率，配置化；用于"能否完成任务并返充"判定 | 精度要求不高 |
| ROS2 topic/service/action 全家桶 + `rmf_adapter` bindings | **去除** | 进程内事件总线（Spring ApplicationEvent + Disruptor 可选）；跨模块契约沿用 `task_state_update` JSON 结构 | — |

### 5.2 内核域模型（核心类）

```java
// graph
class TopologyGraph { List<Waypoint>; List<Lane>; Map<String,Integer> nameIndex;
                      Map<Integer,Set<Integer>> lanesFrom/lanesInto; }
class Waypoint { int index; String map; double x,y; String name;
                 boolean holdingPoint, passthroughPoint, parkingSpot, charger; String mutexGroup; }
class Lane { int index; Node entry, exit; Double speedLimit; String mutexGroup; LaneEvent event; }
sealed interface LaneEvent permits Dock, Wait {}          // 门/电梯事件已去除

// planner
class Planner { TopologyGraph g; Graph<Integer,DefaultWeightedEdge> jgrapht;   // 预构建
  PlanResult plan(PlanStart start, PlanGoal goal, Set<LaneClosure> closures);
  // 返回: waypoint 序列 + 每 leg 预计耗时(长度/限速 + 事件耗时) + 总 ETA + cost
  Optional<GraphAttachment> attachToGraph(String map, Point2D pos);            // 吸附校验, 阈值 3.0m/1.0m 对齐现网
}

// traffic（替代 schedule+negotiation+blockade）
class TrafficRegistry {                                        // 单进程正本, 快照镜像写 Redis
  boolean tryAcquire(String robotId, List<ResourceId> path, Duration lease);  // lane/waypoint/mutexGroup 三级
  void release(String robotId, ResourceId reached);           // 到达即释放后方资源(对齐 blockade reached)
  Map<String,Set<String>> mutualExclusionGroups();
  Optional<Detour> planDetour(String blockedRobot);           // 让路: 最近 holding_point 规划
}

// task
enum TaskStatus { QUEUED, UNDERWAY, COMPLETED, FAILED, KILLED, CANCELED }   // 对齐 task_state_update 契约
class TaskDefinition { String category; Map<String,Object> params;          // description 原样
                       TaskModel model(...); }
interface TaskModel { Estimate estimateFinish(RobotSnapshot s, TravelEstimator t); }
class Estimate { RobotSnapshot finishState; long waitUntilMs; }
class ActiveTask { Deque<Phase> pending; Phase active; TaskStatus status;
                   boolean finished(); Optional<ResumeToken> interrupt(); }
sealed interface Phase permits GoToPlace, PerformAction, ReturnHome, WaitForCharge, CacheTaskContext

// assign
class TaskAssigner { AssignmentResult assign(long nowMs, List<RobotSnapshot> agents, List<TaskRequest> requests);
  // 代价: w_t·finishTime + w_soc·penalty(soc) + w_busy·busyCount  (预置 FASTEST / BATTERY_AWARE) }

// fleet
class RobotHandle {                                            // 对齐 robot_handle.py
  CmdResult navigate(Destination d);                           // cmdId 递增, rmfCommandUid = {instance}:{robot}:{seq}
  CmdResult startActivity(String activity, Map desc);          // 返回 path 时 override 计划
  CmdResult stop(String runningCmdId, String stopCmdId);
  void onStatusTick(RobotStatusSnapshot s);                    // completed_commands 匹配 → execution finished/error + ack
  // decommission/stale/离图 逻辑全量移植 (§7.2)
}
```

### 5.3 任务执行链路（对齐现有 fork 行为）

```
POST /dispatch_task
 → Dispatcher.submit(): 生成 scheduler_request_id, 记录 persisted(published)
 → [指定robot] 直接选择 / [自动] TaskAssigner 分配 (fleet/robot_group 过滤 + battery 可行性)
 → 回执等价物: 分配成功即 rmf_response_received=true, 生成 rmf_task_id  ← 字段名保留, 值改为内部 ID 生成规则
 → ActiveTask 逐 Phase 执行:
     GoToPlace      → Planner 规划 → TrafficRegistry.tryAcquire(全路径) →
                      失败: 排队等待(占用释放事件触发重试) / 让路重规划
                      成功: RobotHandle.navigate(终点透传 RMF 坐标) → 等待 RMS completed_commands
     PerformAction  → RobotHandle.startActivity(quality_inspection/charge/swap_battery/...)
     ReturnHome     → GoToPlace(home_waypoint)
 → 事件总线发布 TaskStateEvent(结构=旧 task_state_update JSON):
     {booking:{id}, status, detail, cancellation, assignedTo:{group,name}}
 → 状态机: queued → underway → completed|failed|killed|canceled
     fork 语义保留: 活动任务被取消 → 发布 completed + cancellation{labels:[source,reason]} (下游依赖此标记!)
     排队任务取消 → 直接 canceled
 → 终态写库 + 快照镜像更新; GC 定时任务对齐 60s/1800s/7200s 语义(§8.1)
```

### 5.4 交通互斥与让路（替代协商的简化算法）

1. `tryAcquire` 按"起点→终点"整条 lane 序列 + 关键 waypoint（终态点、充电桩点、互斥组成员）加租约占用
2. 占用失败 → 任务进入 `WAITING_RESOURCE`（对外仍显示 queued），订阅释放事件重试
3. 死锁检测：周期（5s）构建等待图，发现环 → 选牺牲者（优先级最低：任务优先级 < 剩余电量 < 已等待时长倒序）→ `planDetour` 导航至最近 holding_point（非互斥组、非占用）→ 释放资源 → 环破
4. 单向/窄道：地图标记 `mutex_group` 的 lane 组一次仅一机器人（对齐 RMF mutex_group_supervisor）
5. lane 开闭/限速：运行时接口修改 `TopologyGraph` 权重/可用性（对齐 lane_closure_requests/speed_limit_requests 能力，通过内部 API 暴露，暂不对外）

---

## 6. REST API 兼容层（目标：字段一模一样）

### 6.1 端点清单（18 个，全部保留）

| 类别 | 端点 | 要点 |
|---|---|---|
| 任务 | `POST /api/v1/scheduler/assign-task` | 501 语义保留（robot_code 缺失时） |
| | `POST /api/v1/scheduler/goto-place` | msg 固定 `request published; execution pending` |
| | `POST /api/v1/scheduler/dispatch_task` | 类型归一(battery_swap→swap_battery 等)、replaceBattery 返 400 |
| | `POST /api/v1/scheduler/stop-task` | task_id/rmf_task_id/robot_code 三选一定位；409 语义保留 |
| | `GET /api/v1/scheduler/rmf/tasks` | robot_code/execution_final/status/limit≤1000/verbose |
| | `GET /api/v1/scheduler/tasks/{task_id}/status` | raw.task_state 嵌套结构 |
| | `GET /api/v1/scheduler/tasks/status?scheduler_request_id=` | 同上 |
| | `GET /api/v1/scheduler/pre-switch-check` | check_result 五态 + robots/tasks 明细(50 封顶) |
| 资源 | `POST /api/v1/scheduler/release-robot` | taskflow 级/单机级释放 |
| | `POST /api/v1/scheduler/assign-charger` | 400/404/409/502/503/504 全对齐 |
| | `POST /api/v1/scheduler/release-charger` | robot_code/charger_waypoint 至少其一 |
| | `GET /api/v1/scheduler/robot-resources` | 现状恒返回 `{}`，保持 |
| | `POST /api/v1/scheduler/release-resources` | — |
| | `GET /api/v1/scheduler/scene-resources/status` | configured/scene_code/bundle_version/... |
| | `POST /api/v1/scheduler/scene-resources/reload` | 现状固定 skipped 响应，保持 |
| | `GET /api/v1/resources/status` | +local_path |
| 运行态 | `GET /api/v1/runtime/fleets/snapshot` | scene/fleets/robots/tasks/planning/chargers/components 全结构 |

### 6.2 兼容细节清单（契约测试覆盖项）

1. **envelope**：`{"status":0,"msg":"success","data":...,"timestamp":<unix_ms int>}` —— 在 `scheduler-common` 定义 `ApiEnvelope`（不复用 `Result`，因多 `timestamp` 字段且 msg 有固定文案）
2. **错误格式**：旧系统错误为 FastAPI 风格 `{"detail":"..."}` + 400/404/409/501/502/503/504——`GlobalExceptionHandler` 增加 API 模式适配（路径前缀 `/api/v1/**` 走 detail 格式，内部管理接口走 `Result` 格式）。**需与上层确认是否依赖此格式**（风险项）
3. **字段名兼容**：`rmf_task_id`、`rmf_response_received`、`dispatch_status: published|rmf_response_received|cancel_requested`、`execution_final` 等名称全部保留（尽管底层已无 RMF）
4. **task_status 归一化**：输入端接受 RMF 全集（queued/selected/dispatching/dispatched/active/underway/...），输出端映射到 {queued,running,completed,failed,canceled} + 派生态 {cancel_requested,stale,unknown}；判定优先级链（task_state 终态 > cancel 失败 > cancel_requested > 响应超时 > published）逐条移植
5. **数值精度**：battery 0–100 保留 1 位小数（0.42→42.0）；current_point 为 waypoint index 字符串
6. **robot_code 清洗**：非 `[A-Za-z0-9_]` → `_`，空 → `robot`，数字开头加 `robot_` 前缀
7. **TTL 常量**：LIVE_ROBOT_ONLINE_TTL=15s、TASK_STATE_TTL=10s、ABANDON=1800s(min 300)、终态保留 7200s、PRE_SWITCH 明细 50
8. **snapshot 行为**：scene_code 不匹配返回空记录集、task_limit 截断但计数全量、stale 任务不计 running、offline/error/unknown/paused 不可派、MOVING 有任务仍 dispatchable、15s 无更新 offline
9. **stop-task 行为**：robot_code 取最新活跃非终态任务、`_rmf_only`（仅 task_state 存在）任务可取消、重复取消幂等、cancel 响应超时→failed
10. **pre-switch-check**：BLOCKING={running}、IDLE 含 charging、超龄任务降级 warning、无 fleet_states → unknown+allowed=true

### 6.3 契约测试策略

- 将 `test_rest_api.py` 的断言逐条转译为 JUnit5 + MockMvc（内核 Mock 实现：MockRmsClient + 内存 TrafficRegistry）
- golden-file 测试：对 snapshot/pre-switch-check 全字段做 JSON 快照断言（序列化字段顺序不敏感）
- 上线前灰度：旧服务与新服务并行，diff 工具比对 18 端点响应（同 RMS mock 输入）

---

## 7. RMS HTTP 客户端

### 7.1 端点与参数（全量复刻 adapters/robot_management/client.py）

| 方法 | 端点 | 请求 | 说明 |
|---|---|---|---|
| GET | `/api/v1/robot-management/rmf/fleets/{fleet}/inventory` | — | 机器人清单（上线发现、compatible_chargers、home_waypoint、decommissioned） |
| GET | `/api/v1/robot-management/rmf/fleets/{fleet}/status?robot_name=` | — | 状态轮询（position/battery/online_status/replàn/completed_commands） |
| POST | `.../robots/{code}/navigate` | `{cmd_id, map_name, destination:{x,y,yaw}, speed_limit, description}` | 坐标原样透传（RMF 坐标系） |
| POST | `.../robots/{code}/start-activity` | `{cmd_id, activity, label, description}` | dock/clean/quality_inspection/charge/swap_battery；响应 `data.path` → 路径覆写 |
| POST | `.../robots/{code}/stop` | `{running_cmd_id, stop_cmd_id}` | 取消停机用 |
| POST | `.../robots/{code}/pause-task` | `{cmd_id, body_task_id?, action_id?, task_type?}` | — |
| POST | `.../robots/{code}/resume-task` | `{cmd_id, body_task_id?, action_id?, task_type?}` | — |
| POST | `.../robots/{code}/completions/{completion_id}/ack` | — | 回执确认 |

### 7.2 客户端行为规范（对齐现网参数）

- 超时 connect 3s / read 15s；连接池 50/100；无自动重试（重试在上层命令执行器）
- 响应信封双兼容：`{status,msg,data}` 与 `{success,data}`；命令结果三态 `SUCCESS/RETRY/IMPOSSIBLE`（HTTP/网络错误→RETRY；navigate/stop/pause/resume 可重试，start-activity 默认不可重试）
- 命令执行器：每机器人 `command_lock` 串行；重试 3 次退避 1s；generation 机制取消旧命令；`running_command_uid = {instanceId}:{robotCode}:{seq}`
- 轮询调度：状态 1Hz（可配 10Hz）、inventory 0.1Hz、stale 15s（快照过期整帧丢弃）；实现为虚拟线程（Java 21）每 fleet 一个 poller
- `completed_commands` 匹配顺序：`rmf_command_uid` 精确 → `cmd_id` → `last_completed_request` 兜底；FAILED/REJECTED/TIMEOUT → execution error
- 下线触发（4 处）：decommissioned=true / inventory 消失 / 状态 stale 15s（retention=max(4×stale,300s)，恢复自动重新上线）/ 位置离图（`attachToGraph` 失败，30s 限频告警）
- 断路：Resilience4j circuit breaker 按 RMS 实例维度，OPEN 期间机器人标记状态不可用
- Mock 实现：`MockRmsClient`（对应旧 `--mock-task-execution` 模式 + qcrobotmock 思路，支持脚本化 completed_commands 序列，用于契约测试/联调）

---

## 8. 数据存储设计

### 8.1 PostgreSQL（库名 `scheduler_service`，独立 `-flyway` 模块）

| 表 | 关键列 | 对齐旧物 |
|---|---|---|
| `t_task_record` | scheduler_request_id(UK), business_task_id, rmf_task_id, category, task_status, dispatch_status, payload jsonb, response jsonb, cancel_request jsonb, message, scene_code, created_at, updated_at, abandoned_at, archived_at | file_task_record_repository.json + .archive.jsonl |
| `t_task_state` | rmf_task_id(UK), status, category, detail jsonb, message, inspection_result jsonb, updated_at | task_state 镜像 |
| `t_charger` | charger_id(UK), waypoint, point_code, rmf_level, map_code, scene_code, resource_type, connector_type, compatible_fleets[], fleet_name, status, occupied_by, reserved_by, enabled, updated_at | chargers.json + charger_pool 内存态 |
| `t_scene_resource_bundle` | scene_code+resource_type+bundle_version(UK), checksum, storage_object_key, status, loaded_at, source | `<scene>/current/*.json` 目录 |
| `t_robot_home` | robot_code(UK), home_waypoint, fleet_name, robot_group, enabled | homes.json + robot home yaml |
| `t_point` | scene_code, point_code(UK), point_name, rmf_waypoint | points.json |
| `t_traffic_event`(审计) | id, scene_code, robot_code, resource_id, action(ACQUIRE/RELEASE/DETOUR), detail jsonb, created_at | 新增（可观测） |

任务 GC 定时任务语义对齐：终态 7200s 后归档（软删/归档表）；非终态 1800s 无心跳 → abandoned（查询接口隐藏）。

### 8.2 Redis（运行态镜像 + 锁，key 前缀 `robot:scheduler:`）

| Key | 类型 | TTL | 用途 |
|---|---|---|---|
| `robot:scheduler:fleet_state:{fleet}` | Hash(robot_code→json) | 15s | 机器人实时镜像（快照接口读、多实例共享） |
| `robot:scheduler:task_state:{id}` | String(json) | 10s | 任务实时镜像 |
| `robot:scheduler:charger:lock` | Redisson RLock | — | allocate/release 原子性 |
| `robot:scheduler:assign:lock` | RLock | — | 分配器触发互斥（多触发源） |
| `robot:scheduler:leader` | 租约 | — | 预留单主选主（微服务化时启用） |

### 8.3 MinIO/S3

- `nav_graph/{scene}/{version}.yaml` 原档 + 场景 bundle 打包存档
- 任务归档导出（替代 `.archive.jsonl`，按日对象）
- 通过 robot-common-storage 的 `ObjectStorageService` 使用

---

## 9. 通讯方式设计

| 通道 | 旧 | 新 |
|---|---|---|
| 上层 ↔ 调度 | HTTP(轮询) | **不变**（HTTP 轮询，字段一模一样；SSE 推送作为可选增强接口，不影响兼容） |
| 调度 ↔ RMS | HTTP(轮询+命令) | **不变**（HTTP，RestClient 重写） |
| rest-api ↔ RMF core ↔ adapter | ROS2 DDS | **进程内事件总线**（Spring ApplicationEvent；热路径如状态 tick 用直接回调/Disruptor 可选） |
| 内部事件契约 | task_state_update JSON | 沿用同构 JSON（`TaskStateEvent`），保证行为语义一致、便于日志比对 |
| 跨实例（预留） | — | Redis pub/sub + 租约选主 |

不引入 MQ（Kafka/RabbitMQ）：现有链路无异步解耦诉求，轮询 + 事件总线已覆盖；将来微服务化再评估。

---

## 10. 与现有系统的替换关系

| 旧组件 | 去向 |
|---|---|
| robot-scheduler-rest-api 容器 | → 下线（scheduler-api 模块替代，端口仍 8090 可配） |
| rmf-qc-fleet-adapter 容器 | → 下线（scheduler-core.fleet + scheduler-rms-client 替代） |
| RMF core 容器（schedule/dispatcher/blockade/supervisors） | → 下线 |
| robot_scene_charger_pool | → 下线（ChargerPoolService 替代） |
| robot-rmf-scenes（场景 bundle 仓库） | → 保留，作为 scene bundle 来源；新系统从 bundle 加载入库/S3 |
| robot-rmf-deploy（部署编排） | → 精简为单服务 + PG/Redis/MinIO 依赖（复用 qc-robot infrastructure compose） |

---

## 11. 实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 脚手架**（1 周） | Maven 多模块 + 依赖基线 + ApiEnvelope/DTO/错误码 + MockMvc 骨架；robot-common 接入 | 空服务起 8090，契约测试框架跑通 |
| **P1 API+Mock**（2 周） | 18 端点全部实现，内核用 MockCore（含任务状态机假实现）；`test_rest_api.py` 断言 100% 转译 | 契约测试全绿；与旧服务 golden diff 一致（mock 输入） |
| **P2 RMS 接入**（1 周） | scheduler-rms-client + 轮询 + 上下线/stale/离图 + fleet_state 镜像（Redis） | 对 RMS mock/真机联调：inventory/status/navigate/stop 链路通 |
| **P3 内核闭环**（3 周） | TopologyGraph + nav_graph 解析 + Planner + TrafficRegistry + TaskExecutor（GoToPlace/PerformAction）+ 指定 robot 下发 | 单机器人 go_to_place / quality_inspection 全链路（真机或 qcrobotmock） |
| **P4 分配与多机**（2 周） | TaskAssigner（BatteryAware）+ dispatch_task 自动分配 + 让路/死锁检测 + 电量模型 + charge/swap_battery/return_home + pause/resume | 多机器人并发任务、窄区互斥、低电量返充场景测试 |
| **P5 资源与运营**（2 周） | ChargerPoolService + pre-switch-check + 场景资源加载（bundle→DB/S3）+ 归档 GC + 契约全量回归 | 18 端点行为与旧系统一致（灰度 diff）；运维文档 |
| **P6 上线**（1 周） | 并行灰度（新旧同接 RMS 只一套下发，或按 fleet 切流）→ 全量切换 | 生产 2 周稳定后下线旧栈 |

**测试金字塔**：内核纯 Java 单测（H2/内存图，覆盖规划/占用/状态机）→ MockMvc 契约测试（P1 建）→ Testcontainers 集成测试（PG/Redis）→ qcrobotmock 仿真端到端 → 现场灰度。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 上层对 FastAPI `{"detail":...}` 错误格式的隐性依赖 | P0 与 taskflow 团队确认；不确定则完整模拟该格式（成本低） |
| fork 定制语义遗漏（completed+cancellation 取消标记等） | 已在调研中定位；契约测试覆盖取消全场景（排队/活动/重复/超时） |
| 简化交通模型在极端多机场景死锁 | 占用全路径 + 让路点 + 等待环检测；预留"交通粒度细化到轨迹分段"的扩展点（TrafficRegistry 接口化） |
| RMS 接口行为差异（信封双格式、completion 乱序） | 双格式解析已列入客户端规范；cmd_id/uid 双匹配兜底 |
| 单实例内核的可用性 | 无状态快照 + 任务正本在 PG，重启恢复（未终态任务重新入队/按 RMS 状态对账）；多实例预留选主 |
| 时间估算精度下降（去掉运动学插值） | ETA 仅影响分配代价与显示，不影响执行正确性；用真机数据校准 lane 均速参数 |

---

## 附录 A：关键常量对齐表（scheduler-common/Constants）

```
DEFAULT_REQUESTER = "taskflow-management-service"
REQUEST_PUBLISHED_MESSAGE = "request published; execution pending"
LIVE_ROBOT_ONLINE_TTL_MILLIS = 15_000
RMF_TASK_STATE_TTL_MILLIS = 10_000
DEFAULT_TASK_ABANDON_SECONDS = 1800 (min 300)
RECORD_RETENTION_SECONDS = 7200
PRE_SWITCH_CHECK_MAX_DETAIL_ITEMS = 50
RUNTIME_TASK_LIST_LIMIT = 200 (max 1000) ; RMF_TASK_LIST_LIMIT = 100 (max 1000)
MAX_MERGE_WAYPOINT_DISTANCE = 3.0 ; MAX_MERGE_LANE_DISTANCE = 1.0
COMMAND_RETRY = 3 次 / 退避 1.0s ; RMS_TIMEOUT = (3s, 15s)
STOP_ON_TASK_CANCEL = true
ROBOT_MODE 枚举 0..11 → 归一化 charging/running/paused/waiting/error/idle
TERMINAL_TASK_STATUSES = {completed, failed, canceled}
任务类型归一: battery_swap→swap_battery, returnHome→return_home, pause→pause_task, resume→resume_task
```

## 附录 B：RMF 模块处置速查

- **保留(简化)**：agv/Graph、agv/Planner、schedule 的资源占用语义、rmf_task 模型与 TaskPlanner、charger_pool、battery(线性化)、lane 开闭/限速
- **重构**：schedule+negotiation+blockade → TrafficRegistry；fleet_adapter → RobotHandle/TaskExecutor；dispatcher → 进程内 Dispatcher
- **去除**：ROS2/DDS 全栈、C++ bindings、Mirror/Patch、分布式协商、door/lift supervisor、traffic_editor、仿真/可视化/web、delivery/loop/patrol/clean/read_only、dispenser/ingestor/workcell
