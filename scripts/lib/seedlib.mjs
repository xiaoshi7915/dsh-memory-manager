/**
 * 验收种子数据生成（seed-2000 与 verify 共用）。
 * @module scripts/lib/seedlib
 */

export const TOPICS = [
  { topic: '数据分析', attrs: ['常用工具', '推荐教材', '核心方法', '就业方向', '入门路径'] },
  { topic: '编程语言', attrs: ['语法特点', '适用场景', '学习难度', '流行框架', '性能表现'] },
  { topic: '项目管理', attrs: ['常用工具', '里程碑设定', '风险应对', '团队协作', '进度跟踪'] },
  { topic: '健康生活', attrs: ['最佳作息', '推荐饮食', '运动建议', '睡眠习惯', '减压方式'] },
  { topic: '旅行规划', attrs: ['推荐城市', '最佳季节', '必去景点', '预算建议', '交通方式'] },
  { topic: '英语学习', attrs: ['背词方法', '听力训练', '口语练习', '阅读材料', '考试规划'] },
  { topic: '理财投资', attrs: ['储蓄比例', '风险偏好', '基金选择', '长期规划', '记账习惯'] },
  { topic: '阅读写作', attrs: ['经典书目', '写作技巧', '阅读方法', '输出习惯', '素材积累'] },
  { topic: '音乐创作', attrs: ['编曲软件', '乐理重点', '练习计划', '风格偏好', '灵感来源'] },
  { topic: '运动健身', attrs: ['训练计划', '饮食搭配', '恢复方法', '装备选择', '目标设定'] },
]

export const VALUE_POOLS = [
  ['Python', 'Excel', 'SQL', 'Tableau', 'Power BI', 'R语言', 'Jupyter', 'pandas', 'NumPy', 'Matplotlib',
   'Seaborn', 'scikit-learn', 'Spark', 'Flink', 'Hive', 'Doris', 'ClickHouse', 'Airflow', 'dbt', 'Looker',
   'Superset', 'Metabase', 'Kafka', 'FlinkSQL', 'Presto', 'Trino', 'Snowflake', 'Redshift', 'BigQuery', 'Databricks',
   'DuckDB', 'Polars', 'OpenRefine', 'KNIME', 'RapidMiner', 'Weka', 'Orange', 'TensorFlow', 'PyTorch', 'XGBoost'],
  ['Python', 'Java', 'Go', 'Rust', 'C++', 'C#', 'TypeScript', 'JavaScript', 'Ruby', 'PHP', 'Swift', 'Kotlin',
   'Scala', 'Haskell', 'Elixir', 'Clojure', 'Dart', 'Lua', 'Julia', 'Zig', 'Shell', 'SQL', 'R', 'MATLAB',
   'Objective-C', 'Perl', 'F#', 'Erlang', 'OCaml', 'Groovy', 'VBScript', 'PowerShell', 'Assembly', 'Verilog',
   'COBOL', 'Fortran', 'Pascal', 'Delphi', 'Ada', 'Racket'],
  ['Jira', 'Trello', 'Asana', '飞书项目', 'Teambition', 'Worktile', 'Redmine', 'ClickUp', 'Monday', 'Notion',
   'Basecamp', 'Smartsheet', 'Wrike', 'Zenhub', 'Linear', 'Shortcut', 'Clubhouse', 'Trac', 'GitLab', 'Taiga',
   '禅道', 'ONES', 'PingCode', 'TAPD', 'Confluence', 'Wiki', 'BookStack', 'XMind', 'ProcessOn', 'draw.io',
   'Mermaid', '甘特图', '燃尽图', '看板', '冲刺', '里程碑', 'WBS', 'PDCA', 'OKR', 'KPI'],
  ['早睡早起', '午间小憩', '晨跑', '瑜伽', '冥想', '充足饮水', '均衡饮食', '少糖少油', '高纤维', '优质蛋白',
   '深睡八小时', '规律三餐', '深呼吸', '拉伸放松', '泡脚', '晒太阳', '散步一万步', '骑行', '游泳', '爬山',
   '番茄工作法', '听轻音乐', '写日记', '正念', '减少熬夜', '多蔬果', '坚果零食', '绿茶', '蜂蜜水', '温牛奶',
   '睡前读书', '远离屏幕', '规律作息', '劳逸结合', '定期体检', '补充维C', '晒太阳补钙', '饭后慢走', '温水泡脚', '早上一杯水'],
  ['杭州', '成都', '厦门', '青岛', '大理', '丽江', '桂林', '三亚', '张家界', '西安', '北京', '上海', '广州', '深圳',
   '重庆', '长沙', '武汉', '南京', '苏州', '无锡', '宁波', '温州', '福州', '厦门', '哈尔滨', '长春', '沈阳', '大连',
   '威海', '烟台', '青岛', '拉萨', '昆明', '贵阳', '南宁', '海口', '乌鲁木齐', '敦煌', '喀纳斯', '西双版纳'],
  ['艾宾浩斯记忆法', '词根词缀', '语境记忆', '间隔重复', '每天50词', '每日精听', '影子跟读', 'BBC六分钟', '经济学人',
   '美剧跟读', '原版小说', '口语角', '语音纠错', '每日一句', '思维导图', '联想记忆', '首字母缩略', '口诀', '单词卡片',
   '真题精练', '剑桥真题', '托福TPO', '雅思机经', '四六级真题', '晨读', '晚复盘', '读写结合', '以听带说', '以说促写',
   '磨耳朵', '连读弱读', '语调模仿', '场景对话', '角色扮演', '英文日记', '笔记法', '康奈尔笔记', '费曼学习法', '刻意练习'],
  ['工资50%', '工资30%', '工资20%', '应急金3个月', '应急金6个月', '定投指数', '定投宽基', '核心+卫星', '低波动',
   '高收益伴随高风险', '分散配置', '股债平衡', '80/20法则', '4321法则', '标准普尔象限', '货币基金', '债券基金', '混合基金',
   '黄金对冲', '保险保障', '养老定投', '复利思维', '被动收入', '价值投资', '长期持有', '定投纪律', '记账复盘', '预算控制',
   '节流开源', '量入为出', '不借贷消费', '信用卡还款', '资产配置', '再平衡', '止盈止损', '定投微笑曲线', '货币时间价值', '通胀对冲', '五三二原则', '稳健优先'],
  ['百年孤独', '活着', '平凡的世界', '红楼梦', '围城', '月亮与六便士', '小王子', '局外人', '老人与海', '追风筝的人',
   '高效能人士的七个习惯', '刻意练习', '认知觉醒', '被讨厌的勇气', '乌合之众', '思考快与慢', '原则', '纳瓦尔宝典', '穷查理宝典', '黑天鹅',
   '输出倒逼输入', '多读经典', '主题阅读', '快速阅读', '精读笔记', '卡片笔记法', '费曼输出', '写作日更', '素材库', '灵感本',
   '开头钩子', '故事化表达', '金字塔原理', '结构化写作', '白描', '修辞克制', '金句收尾', '读者视角', '反复修改', '投稿反馈'],
  ['FL Studio', 'Ableton Live', 'Logic Pro', 'Cubase', 'Pro Tools', 'GarageBand', 'BandLab', 'Studio One', 'Reason',
   'LMMS', 'Cakewalk', 'Reaper', 'Mixcraft', 'Bitwig', 'Maschine', 'MPC', 'Serum', 'Sylenth1', 'Omnisphere', 'Kontakt',
   '五声音阶', '和声进行', '节奏型', '音色设计', '混响', '压缩器', 'EQ均衡', '侧链', '母带处理', '采样',
   '每日音阶', '视唱练耳', '扒带练习', '即兴演奏', '节拍器练习', '慢练', '分段练习', '录音复盘', '舞台表现', '创作日记'],
  ['深蹲', '卧推', '硬拉', '引体向上', '俯卧撑', '平板支撑', '卷腹', '波比跳', '跳绳', '慢跑', '快走', '登山',
   '椭圆机', '划船机', '动感单车', '瑜伽轮', '哑铃训练', '杠铃训练', '弹力带', '壶铃', '配速跑', '间歇跑', 'LSD长距离',
   '高蛋白饮食', '碳水循环', '增肌餐', '减脂餐', '蛋白粉', '支链氨基酸', '肌酸', '拉伸', '泡沫轴', '冰敷', '热敷',
   '护膝', '护腕', '跑步鞋', '压缩衣', '心率表', '运动手环', '补水时机', '睡眠恢复', '核心训练', '体态矫正'],
]

const N = 2000

/** 由序号生成第 i 条记忆的内容（10 主题 × 5 属性 × 40 取值 = 2000 唯一）。 */
export function makeContent(i) {
  const topicIdx = i % TOPICS.length
  const t = TOPICS[topicIdx]
  const attrIdx = Math.floor(i / TOPICS.length) % t.attrs.length
  const valIdx = Math.floor(i / (TOPICS.length * t.attrs.length)) % 40
  const value = VALUE_POOLS[topicIdx][valIdx]
  return `${t.topic}：${t.attrs[attrIdx]}是${value}。`
}

/** 由序号还原 (topic, attr, value)。 */
export function decompose(i) {
  const topicIdx = i % TOPICS.length
  const t = TOPICS[topicIdx]
  const attrIdx = Math.floor(i / TOPICS.length) % t.attrs.length
  const valIdx = Math.floor(i / (TOPICS.length * t.attrs.length)) % 40
  return { topic: t.topic, attr: t.attrs[attrIdx], value: VALUE_POOLS[topicIdx][valIdx] }
}

export const TOTAL = N
