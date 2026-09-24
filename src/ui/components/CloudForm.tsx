import { useState } from 'preact/hooks';
import { Stack, Button, Row, Spinner } from '@/ui/components/base';
import { Select } from '@/ui/components/HostForm'
import { post } from '@/ui/platform/vscode';
import { CloudFormState, CloudFormOptions } from '@/models';




export function CloudForm({ formState, options, vendors }: { formState: CloudFormState, options: CloudFormOptions, vendors: string[][] }) {

    if (formState === "loading") {
        return <Row gap={6} pad="8px"><Spinner size={16} />Loading Form Options</Row>
    }

    const [osImageName, setOsImageName] = useState(options.image[0][0]);
    const [instanceType, setInstanceType] = useState("t3.medium");
    const [region, setRegion] = useState("us-east-1");
    const [vendor, setVendor] = useState("AWS");


    const submit = () => {
        post({
            command: "launchCloudInstance",
            cloudLaunchParams: {
                image: osImageName,
                type: instanceType,
                region: region,
                vendor: vendor
            }
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
    // }


}


