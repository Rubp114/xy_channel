#!/usr/bin/env python3
"""
日志精简工具 - 提取关键信息
只保留时间、级别、子系统和实际日志内容
"""

import json
import sys
from datetime import datetime


def extract_log_content(log_obj):
    """提取数字键中的所有日志内容"""
    contents = []
    # 提取所有数字键的内容（"0", "1", "2"...）
    for key in sorted(log_obj.keys()):
        if key.isdigit():
            value = log_obj[key]
            # 如果值是字典或列表，转换为JSON字符串
            if isinstance(value, (dict, list)):
                contents.append(json.dumps(value, ensure_ascii=False))
            else:
                contents.append(str(value))
    return " | ".join(contents) if contents else ""


def extract_subsystem(log_obj):
    """提取子系统名称"""
    if "_meta" in log_obj and "name" in log_obj["_meta"]:
        name = log_obj["_meta"]["name"]
        # 如果是JSON格式的subsystem名称，解析它
        if name.startswith("{"):
            try:
                name_obj = json.loads(name)
                return name_obj.get("subsystem", name)
            except:
                pass
        return name
    return "unknown"


def format_time(time_str):
    """格式化时间为更简洁的格式"""
    try:
        # 解析时间字符串
        dt = datetime.fromisoformat(time_str.replace("+08:00", ""))
        # 只保留时分秒和毫秒
        return dt.strftime("%H:%M:%S.%f")[:-3]
    except:
        return time_str


def simplify_log_line(line):
    """简化单行日志"""
    try:
        log_obj = json.loads(line.strip())

        # 提取关键字段
        time_str = log_obj.get("time", "")
        time_simple = format_time(time_str)

        level = ""
        if "_meta" in log_obj and "logLevelName" in log_obj["_meta"]:
            level = log_obj["_meta"]["logLevelName"]

        subsystem = extract_subsystem(log_obj)
        content = extract_log_content(log_obj)

        # 格式化输出
        if content:
            # 根据日志级别添加颜色标记
            level_marker = {
                "ERROR": "❌",
                "WARN": "⚠️",
                "INFO": "ℹ️",
                "DEBUG": "🔍"
            }.get(level, "•")

            return f"[{time_simple}] {level_marker} [{subsystem}] {content}"

        return None

    except json.JSONDecodeError:
        # 不是JSON格式，直接返回原始行
        return line.strip()
    except Exception as e:
        return f"Error parsing line: {e}"


def process_log_file(input_file, output_file=None, filter_level=None):
    """
    处理日志文件

    Args:
        input_file: 输入文件路径
        output_file: 输出文件路径（可选，默认输出到stdout）
        filter_level: 过滤日志级别（ERROR, WARN, INFO等）
    """
    filter_levels = []
    if filter_level:
        filter_levels = [level.strip().upper() for level in filter_level.split(",")]

    output = open(output_file, 'w', encoding='utf-8') if output_file else sys.stdout

    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue

                # 如果需要过滤级别
                if filter_levels:
                    try:
                        log_obj = json.loads(line.strip())
                        level = log_obj.get("_meta", {}).get("logLevelName", "")
                        if level.upper() not in filter_levels:
                            continue
                    except:
                        pass

                simplified = simplify_log_line(line)
                if simplified:
                    output.write(simplified + '\n')

    finally:
        if output_file:
            output.close()


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(
        description="精简OpenClaw日志，只保留关键信息",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 精简日志并输出到终端
  python simplify_logs.py openclaw.log

  # 精简日志并保存到文件
  python simplify_logs.py openclaw.log -o simplified.log

  # 只显示错误和警告
  python simplify_logs.py openclaw.log -l ERROR,WARN

  # 只显示特定子系统的日志
  python simplify_logs.py openclaw.log | grep "xiaoyi-channel"
        """
    )

    parser.add_argument('input', help='输入日志文件路径')
    parser.add_argument('-o', '--output', help='输出文件路径（默认输出到终端）')
    parser.add_argument('-l', '--level', help='过滤日志级别，逗号分隔（如: ERROR,WARN）')
    parser.add_argument('--no-emoji', action='store_true', help='不使用emoji标记')

    args = parser.parse_args()

    if args.no_emoji:
        # 如果不想要emoji，可以在这里修改level_marker
        pass

    process_log_file(args.input, args.output, args.level)

    if args.output:
        print(f"✅ 日志已精简并保存到: {args.output}")


if __name__ == "__main__":
    main()
