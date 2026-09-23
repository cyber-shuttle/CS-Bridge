import { useState } from 'preact/hooks';
import { Stack, Button } from '@/ui/components/base';
import { Select } from '@/ui/components/HostForm'
import { post } from '@/ui/platform/vscode';
import { CloudFormOptions } from '@/models';




export function CloudForm({ options, vendors }: { options: CloudFormOptions, vendors: string[][] }) {

    const [osImageName, setOsImageName] = useState("AMI");
    const [instanceType, setInstanceType] = useState("t3.medium");
    const [region, setRegion] = useState("us-east-1");
    const [vendor, setVendor] = useState("AWS");


    const submit = () => {
        post({
            command: "launchInstance"
        });
    };

    return (
        <Stack gap={4}>
            <Select label="vendor" value={vendor} onChange={setVendor} options={vendors} />
            <Select label="Instance Type" value={instanceType} onChange={setInstanceType} options={options.type} />
            <Select label="OS Image" value={osImageName} onChange={setOsImageName} options={options.image} />
            <Select label="Region" value={region} onChange={setRegion} options={options.region} />
            <Button onClick={submit} disabled={!vendor && !instanceType && !osImageName && !region}>
                Submit
            </Button>
        </Stack>
    );
}


