# SonarQube Cloud：公开项目接入

## 已核实的实际配置

| 项目 | 值 |
| --- | --- |
| 服务及区域 | SonarQube Cloud EU，https://sonarcloud.io |
| GitHub仓库 | https://github.com/Zhou-chu/thu-campus-mcp ，public |
| Sonar组织键 | `zhou-chu` |
| Sonar项目键 | `Zhou-chu_thu-campus-mcp` |
| Sonar项目可见性 | **public**，已用不带登录态的API验证 |
| 分析链路 | 已安装的SonarQube Cloud GitHub App，Automatic analysis |
| 质量结果入口 | https://sonarcloud.io/dashboard?id=Zhou-chu_thu-campus-mcp&branch=main |

此前GitHub仓库虽然已公开，但Sonar项目仍是private，后台报告因组织私有项目50,000 LOC上限被拒收。2026-11-14已仅将本Sonar项目切换为public；未改其他项目、套餐、质量门、new-code定义或源码排除。公开项目不占私有LOC额度，不能继续把这次阻塞当成公开项目的50k限制。

## 分析与验收

1. main提交后由既有GitHub App自动分析，检查名为`SonarCloud Code Analysis`。不得把已取消的旧检查、仅报告上传成功或本地AST评分当成当前提交通过质量门。
2. 核对最近分析的revision与待验收提交一致，再读取该analysis的质量门和真实issues。质量门失败就按真实问题分批修复、提交复扫，不为变绿裁剪源码、扩大排除或重置new-code基线。
3. 当前采用Automatic analysis，**不提供测试覆盖率**。现有六个前端纯模块的本地V8覆盖率不是Sonar全项目覆盖率；服务端没有coverage数据时必须报告“无数据”，不能写100%或推定通过。
4. 需要Sonar覆盖率时，另接GitHub Actions：先真实生成可定位源码的LCOV，再配置`sonar.javascript.lcov.reportPaths`；切换前在Analysis method关闭Automatic analysis，避免双开冲突。实际组织/项目键使用上表值，`SONAR_TOKEN`只存GitHub Actions Secret，不入仓库、日志或聊天。当前**没有**新增这套CI扫描或Token。
5. 本仓库为公开项目，匿名API可以查询项目、分析与质量结果；修改设置仍需有权限的本人登录。公开状态变化必须回读验证，不以GitHub可见性替代Sonar可见性。

## 不带令牌的核对入口

- [项目元数据与public状态](https://sonarcloud.io/api/components/show?component=Zhou-chu_thu-campus-mcp)
- [最近分析及revision](https://sonarcloud.io/api/project_analyses/search?project=Zhou-chu_thu-campus-mcp&ps=1)
- [当前质量门](https://sonarcloud.io/api/qualitygates/project_status?projectKey=Zhou-chu_thu-campus-mcp)
- [真实问题列表](https://sonarcloud.io/project/issues?id=Zhou-chu_thu-campus-mcp)

“可访问/配置成功”和“当前源码质量门通过”分别验收；首次结果尚未产生时不能报通过。

## 官方依据

- [Free/OSS方案与私有LOC额度](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans)
- [区域选择](https://docs.sonarsource.com/sonarqube-cloud/getting-started/choosing-your-region)
- [Automatic analysis与限制](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/automatic-analysis)
- [JS/TS的LCOV覆盖率接入](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/javascript-typescript-test-coverage)
