#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdint>
#include <cstring>
#include <string>
#include "global.h"
#include "voice_native.h"

namespace WeixinSend { void BuildSendParam2_Image(uint64_t*); }
namespace WeChatAgentVoiceNative {
static constexpr uintptr_t kVoiceFactory = 0x6199d10;
static constexpr uintptr_t kVoiceVtable = 0x8dd0028;
struct VoiceConfig { uint32_t a=4, b=3; uint64_t timeout=30000, flags=0; std::string extra; };
static_assert(sizeof(std::string)==32, "Unexpected C++ string layout");
static_assert(offsetof(VoiceConfig, extra)==0x18, "Unexpected voice configuration layout");
static void* Allocate(size_t size) { return HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,size); }

bool Ready() {
    const auto module=GetModuleHandleW(L"Weixin.dll"); if(!module) return false;
    const auto base=reinterpret_cast<uintptr_t>(module);
    MEMORY_BASIC_INFORMATION info{};
    const unsigned char prologue[]={0x55,0x41,0x56,0x56,0x57,0x53};
    if(!VirtualQuery(reinterpret_cast<void*>(base+kVoiceFactory),&info,sizeof(info)) || info.State!=MEM_COMMIT || !(info.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY))) return false;
    return !memcmp(reinterpret_cast<const void*>(base+kVoiceFactory),prologue,sizeof(prologue));
}

bool Send(const std::string& target,const std::string& silk,uint32_t durationMs) {
    if(!Ready() || target.empty() || target.size()>256 || durationMs==0 || durationMs>60000 || silk.size()<10 || silk.size()>8*1024*1024 || memcmp(silk.data(),"\x02#!SILK_V3",10)) return false;
    const auto base=reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    VoiceConfig config{};
    auto* out=static_cast<uint8_t*>(Allocate(0x100)); if(!out)return false;
    using Factory=void(*)(void*,void*,const std::string*,const std::string*,uint32_t,const VoiceConfig*);
    reinterpret_cast<Factory>(base+kVoiceFactory)(nullptr,out,&silk,&target,durationMs,&config);
    auto* vec=*reinterpret_cast<uintptr_t**>(out+0x38);
    if(!vec || vec[0]!=base+offset::param1_vtable || !vec[1] || vec[2]-vec[1]!=16) return false;
    auto* pair=reinterpret_cast<uintptr_t*>(vec[1]);
    if(!pair[0] || !pair[1]) return false;
    const auto msg=pair[0];
    if(*reinterpret_cast<uintptr_t*>(msg)!=base+kVoiceVtable || *reinterpret_cast<uint32_t*>(msg+0xd8)!=34 ||
       *reinterpret_cast<uint32_t*>(msg+0x728)!=durationMs || reinterpret_cast<std::string*>(msg+0xb0)->size()!=target.size() ||
       reinterpret_cast<std::string*>(msg+0x708)->size()!=silk.size()) return false;
    auto* second=static_cast<uint64_t*>(Allocate(0xe8)); if(!second)return false;
    WeixinSend::BuildSendParam2_Image(second);
    using Dispatch=__int64(*)(uintptr_t,uintptr_t);
    reinterpret_cast<Dispatch>(base+offset::send_message)(reinterpret_cast<uintptr_t>(vec),reinterpret_cast<uintptr_t>(second));
    // The native queue may retain these allocations asynchronously. Match the existing file sender's lifetime policy.
    return true;
}
}
