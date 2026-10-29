#pragma once
#include <cstdint>
#include <string>
namespace WeChatAgentVoiceNative {
bool Ready();
bool Send(const std::string& target, const std::string& silk, uint32_t durationMs);
}
