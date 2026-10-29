"""Verify terminal execution results, rather than accepting quoted success markers."""
import json

def successful_command_outputs(messages,expected_command):
    calls={}
    for message in messages:
        for call in message.get('tool_calls') or []:
            function=call.get('function',{})
            if function.get('name')!='terminal':continue
            try:args=json.loads(function.get('arguments','{}'))
            except (ValueError,TypeError):continue
            if isinstance(args,dict) and call.get('id') and args.get('command','').strip()==expected_command:
                calls[call.get('id')]=args
    outputs=[]
    for message in messages:
        if message.get('role')!='tool' or message.get('tool_call_id') not in calls:continue
        try:result=json.loads(message.get('content',''))
        except (ValueError,TypeError):continue
        if (isinstance(result,dict) and result.get('exit_code')==0 and not result.get('error')
                and isinstance(result.get('output'),str)):
            outputs.append(result['output'])
    return outputs

def command_printed_marker(messages,command,marker):
    return any(marker in output.splitlines() for output in successful_command_outputs(messages,command))

def standalone_marker(text,marker):
    return isinstance(text,str) and marker in [line.strip() for line in text.splitlines()]
